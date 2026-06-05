import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Stateless JSON-RPC-over-POST MCP handler. Each request gets a fresh linked
 * transport pair; the response resolves when the server actually answers
 * (tool calls can take seconds while the editor works), not on a timer.
 */
export async function handleMcpRequest(request: Request, server: McpServer): Promise<Response> {
  try {
    const message = (await request.json()) as JSONRPCMessage

    // Notifications (no id) get no response body per JSON-RPC.
    const isNotification = !('id' in message) || message.id === undefined

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    const responsePromise = isNotification
      ? Promise.resolve(null)
      : new Promise<JSONRPCMessage>((resolve) => {
          clientTransport.onmessage = (incoming: JSONRPCMessage) => {
            if ('id' in incoming && incoming.id === (message as { id: number | string }).id) {
              resolve(incoming)
            }
          }
        })

    await server.connect(serverTransport)
    await clientTransport.start()
    await clientTransport.send(message)

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('MCP request timed out after 120s')), 120_000),
    )
    const responseData = await Promise.race([responsePromise, timeout])

    await clientTransport.close()
    await serverTransport.close()

    if (responseData === null) return new Response(null, { status: 202 })
    return Response.json(responseData)
  } catch (error) {
    console.error('MCP handler error:', error)
    return Response.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
          data: error instanceof Error ? error.message : String(error),
        },
        id: null,
      },
      { status: 500 },
    )
  }
}
