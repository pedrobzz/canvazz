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
  send: (event: string, data: string) => void
  close: () => void
}

const clients: Client[] = []
const pending = new Map<string, Pending>()
let commandCounter = 0

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

/** Forward a tool call to the live editor; resolves with its result. */
export function dispatchToEditor(
  tool: string,
  args: unknown,
  timeoutMs = 20_000,
): Promise<unknown> {
  const client = clients[clients.length - 1]
  if (!client) {
    return Promise.reject(
      new Error(
        'No editor connected. Open the Canvazz editor (default http://localhost:3000) in a browser, then retry.',
      ),
    )
  }
  const id = `cmd_${++commandCounter}_${Date.now().toString(36)}`
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
