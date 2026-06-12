import { executeAiTool } from './aiTools'

/**
 * Browser side of the MCP bridge. The dev server hosts the MCP endpoint;
 * tool calls are forwarded to this editor over SSE, executed against the
 * live document, and posted back. The user literally watches the AI work.
 */

export type BridgeStatus = 'disconnected' | 'connected'

type Listener = () => void
let status: BridgeStatus = 'disconnected'
const listeners = new Set<Listener>()

export const bridgeStatusStore = {
  get: () => status,
  subscribe: (fn: Listener) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

function setStatus(next: BridgeStatus) {
  if (status === next) return
  status = next
  for (const fn of listeners) fn()
}

let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

export function startBridge(projectId: string): () => void {
  connect(projectId)
  return () => {
    if (retryTimer) clearTimeout(retryTimer)
    source?.close()
    source = null
    setStatus('disconnected')
  }
}

function connect(projectId: string) {
  source?.close()
  source = new EventSource(`/api/bridge/stream?project=${encodeURIComponent(projectId)}`)

  source.addEventListener('open', () => setStatus('connected'))

  source.addEventListener('command', (e) => {
    void handleCommand(e as MessageEvent<string>)
  })

  source.addEventListener('error', () => {
    setStatus('disconnected')
    source?.close()
    source = null
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => connect(projectId), 2000)
  })
}

async function handleCommand(e: MessageEvent<string>) {
  let id = ''
  try {
    const command = JSON.parse(e.data) as { id: string; tool: string; args: Record<string, unknown> }
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
