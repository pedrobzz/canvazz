import { executeAiTool } from './aiTools'
import {
  ProjectRegistry,
  type MeshMessage,
  type TabId,
  routeCommand,
  subscriptionKey,
} from './bridgeMesh'

/**
 * Browser side of the MCP bridge. The dev server hosts the MCP endpoint;
 * tool calls are forwarded to the editor over SSE, executed against the live
 * document, and posted back. The user literally watches the AI work.
 *
 * ONE SSE CONNECTION PER BROWSER (see bridgeMesh.ts for the full rationale).
 * Browsers cap HTTP/1.1 at ~6 connections per host; one EventSource per tab
 * exhausted that pool and starved the 4th+ tab's stream, so it never connected
 * (issue #3). Instead:
 *
 *   - Every tab announces the project it owns to its siblings over a
 *     BroadcastChannel and registers it in a shared ProjectRegistry.
 *   - Exactly one tab is elected *leader* via the Web Locks API. The leader
 *     holds a SINGLE EventSource subscribed to the union of all open projects
 *     (`/api/bridge/stream?projects=a,b,c`), and reconnects only when that set
 *     changes.
 *   - When the leader's stream delivers a command for project X, it routes the
 *     command over the channel to whichever tab owns X. That tab executes the
 *     tool against its own editorStore and POSTs the result back itself.
 *   - On leader tab close the Web Lock releases and a sibling is promoted; it
 *     opens the stream and subscriptions are rebuilt from re-announcements.
 *
 * Followers keep zero server connections, so N tabs cost exactly one SSE.
 * `bridgeStatusStore` reports 'connected' once this tab's project is covered by
 * a live stream (leader or follower) — the contract TopBar relies on.
 */

export type BridgeStatus = 'disconnected' | 'connected'

type Listener = () => void

const CHANNEL_NAME = 'canvazz:bridge'
const LOCK_NAME = 'canvazz:bridge:leader'

const newTabId = (): TabId =>
  `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

interface MeshState {
  status: BridgeStatus
  listeners: Set<Listener>
  registry: ProjectRegistry
  tabId: TabId
  /** Projects this very tab owns (usually one, but resilient to remounts). */
  ownProjects: Set<string>
  channel: BroadcastChannel | null
  source: EventSource | null
  isLeader: boolean
  /** The subscription the leader's current EventSource was opened for. */
  subscribedKey: string | null
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Released to abandon leadership when the last project closes / tab unloads. */
  releaseLock: (() => void) | null
  onUnload: (() => void) | null
}

// Vite HMR re-instantiates this module on edit; persist mesh state on the
// window so the single EventSource and elected leadership survive remounts
// instead of leaking a second connection (which would re-trigger issue #3).
const state: MeshState = ((globalThis as Record<string, unknown>).__czBridgeMesh ??= {
  status: 'disconnected',
  listeners: new Set<Listener>(),
  registry: new ProjectRegistry(),
  tabId: newTabId(),
  ownProjects: new Set<string>(),
  channel: null,
  source: null,
  isLeader: false,
  subscribedKey: null,
  retryTimer: null,
  releaseLock: null,
  onUnload: null,
} satisfies MeshState) as MeshState

export const bridgeStatusStore = {
  get: () => state.status,
  subscribe: (fn: Listener) => {
    state.listeners.add(fn)
    return () => state.listeners.delete(fn)
  },
}

function recomputeStatus() {
  // This tab is "connected" when its project is being served by a live stream:
  // either we're the leader with an open source, or a leader exists for our
  // project (a follower trusts the registry + an active channel).
  const haveStream = state.isLeader && state.source !== null
  const covered =
    haveStream ||
    (state.channel !== null &&
      [...state.ownProjects].some((p) => state.registry.has(p)))
  const next: BridgeStatus = covered ? 'connected' : 'disconnected'
  if (state.status === next) return
  state.status = next
  for (const fn of state.listeners) fn()
}

// --- channel I/O -------------------------------------------------------------

function post(msg: MeshMessage) {
  state.channel?.postMessage(msg)
}

function onChannelMessage(msg: MeshMessage) {
  switch (msg.type) {
    case 'announce':
      state.registry.add(msg.tab, msg.project)
      // A late-joining tab needs the leader to widen its subscription, and
      // every tab needs the newcomer in its registry for routing.
      if (state.isLeader) reconcileSubscription()
      recomputeStatus()
      break
    case 'leave':
      state.registry.remove(msg.tab, msg.project)
      if (state.isLeader) reconcileSubscription()
      recomputeStatus()
      break
    case 'whois':
      // A newly promoted leader asks everyone to re-announce so it can rebuild
      // the full subscription set.
      for (const project of state.ownProjects) {
        post({ type: 'announce', tab: state.tabId, project })
      }
      break
    case 'command':
      // Only the owning tab should execute; the leader broadcasts and every
      // tab filters by ownership so we don't need per-tab addressing.
      if (state.ownProjects.has(msg.project)) {
        void handleCommand(msg.payload)
      }
      break
  }
}

// --- leadership --------------------------------------------------------------

function becomeLeader() {
  if (state.isLeader) return
  state.isLeader = true
  // Re-announcements rebuild the registry from scratch under the new leader.
  state.registry.removeTab(state.tabId) // clear our own stale rows first
  for (const project of state.ownProjects) {
    state.registry.add(state.tabId, project)
    post({ type: 'announce', tab: state.tabId, project })
  }
  post({ type: 'whois', tab: state.tabId })
  reconcileSubscription()
  recomputeStatus()
}

function resignLeadership() {
  state.isLeader = false
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  state.source?.close()
  state.source = null
  state.subscribedKey = null
  recomputeStatus()
}

/**
 * Acquire the leader lock. `navigator.locks.request` holds the lock until the
 * returned promise settles; we keep it open with a promise that resolves only
 * when this tab abandons leadership (last project closed or page unload). When
 * the holder tab dies, the browser releases the lock and a waiter is promoted.
 */
function contendForLeadership() {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (!locks) {
    // No Web Locks (old browsers / tests): degrade to per-tab streams. Correct,
    // just back to one-connection-per-tab — still better than a broken mesh.
    becomeLeader()
    return
  }
  void locks.request(LOCK_NAME, () => {
    becomeLeader()
    return new Promise<void>((resolve) => {
      state.releaseLock = resolve
    })
  })
}

// --- leader subscription -----------------------------------------------------

/** Open / re-open the single EventSource to cover every open project. */
function reconcileSubscription() {
  if (!state.isLeader) return
  const projects = state.registry.projects()
  const key = subscriptionKey(projects)
  if (key === state.subscribedKey && state.source) return
  state.subscribedKey = key
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  state.source?.close()
  state.source = null
  if (projects.length === 0) {
    recomputeStatus()
    return
  }
  openStream(projects)
}

function openStream(projects: string[]) {
  const qs = encodeURIComponent(projects.join(','))
  const source = new EventSource(`/api/bridge/stream?projects=${qs}`)
  state.source = source

  source.addEventListener('open', () => recomputeStatus())

  source.addEventListener('command', (e) => {
    const evt = e as MessageEvent<string>
    let project = ''
    try {
      project = (JSON.parse(evt.data) as { project?: string }).project ?? ''
    } catch {
      return
    }
    const decision = routeCommand(state.registry, state.tabId, project)
    if (decision === 'local') void handleCommand(evt.data)
    else if (decision === 'forward') post({ type: 'command', project, payload: evt.data })
    // 'drop': owner closed between dispatch and delivery; server will time out.
  })

  source.addEventListener('error', () => {
    if (state.source !== source) return // superseded by a newer reconnect
    state.source?.close()
    state.source = null
    recomputeStatus()
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      reconcileSubscription()
    }, 2000)
  })
}

// --- command execution (runs on the owning tab) ------------------------------

async function handleCommand(data: string) {
  let id = ''
  try {
    const command = JSON.parse(data) as {
      id: string
      tool: string
      args: Record<string, unknown>
    }
    id = command.id
    const result = await executeAiTool(command.tool, command.args ?? {})
    await postResult({ id, ok: true, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (id) await postResult({ id, ok: false, error: message })
  }
}

async function postResult(payload: { id: string; ok: boolean; result?: unknown; error?: string }) {
  try {
    await fetch('/api/bridge/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error('Bridge result post failed:', err)
  }
}

// --- lifecycle ---------------------------------------------------------------

function ensureChannel() {
  if (state.channel) return
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (e: MessageEvent<MeshMessage>) => onChannelMessage(e.data)
  state.channel = channel
  state.onUnload = () => releaseEverything()
  window.addEventListener('beforeunload', state.onUnload)
  window.addEventListener('pagehide', state.onUnload)
}

function releaseEverything() {
  for (const project of state.ownProjects) {
    post({ type: 'leave', tab: state.tabId, project })
  }
  state.registry.removeTab(state.tabId)
  state.releaseLock?.() // promote a sibling if we held leadership
  state.releaseLock = null
}

/**
 * Register `projectId` for this tab and join the mesh. Returns a cleanup that
 * un-registers the project; if it was this tab's last project and we were the
 * leader, leadership is released so a sibling can take over.
 */
export function startBridge(projectId: string): () => void {
  ensureChannel()

  state.ownProjects.add(projectId)
  state.registry.add(state.tabId, projectId)
  post({ type: 'announce', tab: state.tabId, project: projectId })

  if (state.isLeader) reconcileSubscription()
  else contendForLeadership()
  recomputeStatus()

  return () => {
    state.ownProjects.delete(projectId)
    state.registry.remove(state.tabId, projectId)
    post({ type: 'leave', tab: state.tabId, project: projectId })

    if (state.isLeader) {
      if (state.ownProjects.size === 0) {
        // Hand leadership to a sibling that still has projects open.
        state.releaseLock?.()
        state.releaseLock = null
        resignLeadership()
      } else {
        reconcileSubscription()
      }
    }
    recomputeStatus()
  }
}
