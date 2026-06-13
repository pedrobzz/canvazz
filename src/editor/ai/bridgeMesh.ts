/**
 * Pure, transport-agnostic core of the cross-tab bridge mesh.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each editor tab used to open its own SSE EventSource to
 * `/api/bridge/stream`. Browsers cap HTTP/1.1 at ~6 connections per host, and
 * the dev server's HMR/asset traffic shares that pool, so the 4th–5th tab's
 * SSE request queued forever and its project stayed `open: false`. (Safari has
 * a higher per-host budget, which is why it "just worked" there.)
 *
 * THE FIX: ONE SSE PER BROWSER, FANNED OUT OVER BroadcastChannel
 * -------------------------------------------------------------
 * Exactly one tab (the *leader*, elected via the Web Locks API) holds a single
 * EventSource subscribed to *all* projects open across the browser. When a
 * command arrives for project X, the leader routes it over BroadcastChannel to
 * the tab that actually owns project X (its `editorStore` holds that document).
 * That tab executes the tool and POSTs the result back itself. Followers never
 * open an EventSource, so total browser→server SSE connections stay at one
 * regardless of tab count.
 *
 * This module is the part that has no DOM/network dependencies: the leader
 * election state machine, the per-project ownership registry, and the routing
 * decision (deliver locally vs. forward to a sibling). It is unit-tested with
 * mocked channels/locks; the wiring lives in bridgeClient.ts.
 */

/** A tab's stable identity for the lifetime of the page. */
export type TabId = string

/** Messages exchanged between sibling tabs over BroadcastChannel. */
export type MeshMessage =
  | { type: 'announce'; tab: TabId; project: string }
  | { type: 'leave'; tab: TabId; project: string }
  | { type: 'whois'; tab: TabId }
  | { type: 'command'; project: string; payload: string }

/** A registry of which tab owns which project, across the whole browser. */
export class ProjectRegistry {
  /** project id -> set of tab ids that currently have it open. */
  private readonly byProject = new Map<string, Set<TabId>>()

  add(tab: TabId, project: string): boolean {
    let set = this.byProject.get(project)
    if (!set) {
      set = new Set()
      this.byProject.set(project, set)
    }
    const before = set.size
    set.add(tab)
    return set.size !== before
  }

  /** Remove a (tab, project) pair. Returns true if the set changed. */
  remove(tab: TabId, project: string): boolean {
    const set = this.byProject.get(project)
    if (!set) return false
    const changed = set.delete(tab)
    if (set.size === 0) this.byProject.delete(project)
    return changed
  }

  /** Drop every entry owned by a tab (e.g. when it goes away). */
  removeTab(tab: TabId): boolean {
    let changed = false
    for (const [project, set] of this.byProject) {
      if (set.delete(tab)) {
        changed = true
        if (set.size === 0) this.byProject.delete(project)
      }
    }
    return changed
  }

  /** Most-recently-announced owner wins, matching server dispatch semantics. */
  ownerOf(project: string): TabId | undefined {
    const set = this.byProject.get(project)
    if (!set || set.size === 0) return undefined
    let last: TabId | undefined
    for (const tab of set) last = tab
    return last
  }

  /** Sorted union of all open projects — what the leader must subscribe to. */
  projects(): string[] {
    return [...this.byProject.keys()].sort()
  }

  has(project: string): boolean {
    return this.byProject.has(project)
  }
}

/**
 * Compute the leader's desired SSE subscription. The leader reconnects only
 * when this string changes, so it must be order-stable.
 */
export function subscriptionKey(projects: string[]): string {
  return [...projects].sort().join(',')
}

/**
 * Decide what a tab should do with a command for `project`, given the registry.
 * - `'local'`: this tab owns the project; execute it here.
 * - `'forward'`: a sibling owns it; relay over the channel.
 * - `'drop'`: nobody in this browser owns it (stale/closed tab).
 */
export function routeCommand(
  registry: ProjectRegistry,
  self: TabId,
  project: string,
): 'local' | 'forward' | 'drop' {
  const owner = registry.ownerOf(project)
  if (!owner) return 'drop'
  return owner === self ? 'local' : 'forward'
}
