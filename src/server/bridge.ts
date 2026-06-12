/**
 * Server side of the MCP <-> editor bridge. MCP tool calls are queued here,
 * pushed to the connected editor tab over SSE, executed against the live
 * document, and resolved with the editor's response. In-memory, single-user,
 * local-first — matching the dev-server deployment model.
 */

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Client {
  id: string
  /** Project open in this editor tab; MCP calls are routed by project. */
  projectId: string
  send: (event: string, data: string) => void
  close: () => void
}

interface BridgeState {
  clients: Client[]
  pending: Map<string, Pending>
  commandCounter: number
}

// Vite dev re-instantiates server modules on edit; keeping state on
// globalThis lets existing SSE connections survive module reloads.
const state: BridgeState = ((globalThis as Record<string, unknown>).__czBridge ??= {
  clients: [],
  pending: new Map(),
  commandCounter: 0,
} satisfies BridgeState) as BridgeState

const { clients, pending } = state

export function addBridgeClient(client: Client) {
  clients.push(client)
}

export function removeBridgeClient(id: string) {
  const index = clients.findIndex((c) => c.id === id)
  if (index >= 0) clients.splice(index, 1)
}

export function bridgeClientCount(): number {
  return clients.length
}

/** Project ids with a live editor tab, most recently connected last. */
export function connectedProjects(): string[] {
  return [...new Set(clients.map((c) => c.projectId))]
}

/** Forward a tool call to the editor with that project open. */
export function dispatchToEditor(
  projectId: string,
  tool: string,
  args: unknown,
  timeoutMs = 20_000,
): Promise<unknown> {
  // Most recent tab wins when the same project is open twice.
  const client = [...clients].reverse().find((c) => c.projectId === projectId)
  if (!client) {
    const open = connectedProjects()
    return Promise.reject(
      new Error(
        `No editor tab has project ${projectId} open. ` +
          (open.length > 0
            ? `Currently open: ${open.join(', ')}. `
            : 'No editor tabs are connected. ') +
          `Open /p/${projectId} in the Canvazz app (default http://localhost:47823), then retry.`,
      ),
    )
  }
  const id = `cmd_${++state.commandCounter}_${Date.now().toString(36)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Editor did not respond within ${timeoutMs}ms (tool: ${tool})`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      client.send('command', JSON.stringify({ id, tool, args }))
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      removeBridgeClient(client.id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export function resolveBridgeResult(payload: {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}): boolean {
  const entry = pending.get(payload.id)
  if (!entry) return false
  pending.delete(payload.id)
  clearTimeout(entry.timer)
  if (payload.ok) entry.resolve(payload.result)
  else entry.reject(new Error(payload.error ?? 'Editor reported an error'))
  return true
}
