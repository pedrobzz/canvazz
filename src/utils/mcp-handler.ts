import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Stateless JSON-RPC-over-POST MCP handler.
 *
 * The `McpServer` is a singleton whose underlying Protocol only supports one
 * transport at a time, so the old "connect a fresh transport pair per request"
 * approach raced: two in-flight POSTs (or rapid sequential ones, before close()
 * settled) collided with "Already connected to a transport" (-32603).
 *
 * Fix: connect the singleton ONCE to a persistent linked transport pair and
 * multiplex every concurrent request over it. Each incoming request id is
 * rewritten to a process-unique internal id before being handed to the server;
 * responses are routed back to the right caller by that internal id, and the
 * caller's original id is restored on the way out. No per-request connect, no
 * serializing mutex — true concurrency.
 */

const REQUEST_TIMEOUT_MS = 120_000

interface Connection {
  clientTransport: InMemoryTransport
  /** internal id -> resolver waiting for that response */
  pending: Map<string, (message: JSONRPCMessage) => void>
}

/**
 * One persistent connection per server. A WeakMap (not a module global) so unit
 * tests can spin up their own `McpServer` fixtures and each gets its own pipe.
 */
const connections = new WeakMap<McpServer, Connection>()
/** Serializes lazy connect so concurrent first-hits don't double-connect. */
const connecting = new WeakMap<McpServer, Promise<Connection>>()

let internalIdCounter = 0
function nextInternalId(): string {
  internalIdCounter += 1
  return `mcp-${internalIdCounter}`
}

/** Lazily connect the singleton server to its persistent transport pair. */
async function getConnection(server: McpServer): Promise<Connection> {
  const existing = connections.get(server)
  if (existing) return existing

  const inFlight = connecting.get(server)
  if (inFlight) return inFlight

  const promise = (async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const pending = new Map<string, (message: JSONRPCMessage) => void>()

    clientTransport.onmessage = (incoming: JSONRPCMessage) => {
      if (!('id' in incoming) || incoming.id === undefined || incoming.id === null) return
      const internalId = String(incoming.id)
      const resolve = pending.get(internalId)
      if (resolve) {
        pending.delete(internalId)
        resolve(incoming)
      }
    }

    await server.connect(serverTransport)
    await clientTransport.start()

    const connection: Connection = { clientTransport, pending }
    connections.set(server, connection)
    return connection
  })()

  connecting.set(server, promise)
  try {
    return await promise
  } finally {
    connecting.delete(server)
  }
}

function hasId(message: JSONRPCMessage): message is JSONRPCMessage & { id: number | string } {
  return (
    'id' in message &&
    (message as { id?: unknown }).id !== undefined &&
    (message as { id?: unknown }).id !== null
  )
}

function isJsonRpcObject(value: unknown): value is JSONRPCMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Dispatch a single JSON-RPC message over the persistent pipe.
 * Returns the response message, or `null` for notifications (no id).
 */
async function dispatch(
  connection: Connection,
  message: JSONRPCMessage,
): Promise<JSONRPCMessage | null> {
  if (!hasId(message)) {
    // Notification: fire and forget, no response per JSON-RPC.
    await connection.clientTransport.send(message)
    return null
  }

  const originalId = message.id
  const internalId = nextInternalId()
  const outgoing = { ...message, id: internalId } as JSONRPCMessage

  const responsePromise = new Promise<JSONRPCMessage>((resolve) => {
    connection.pending.set(internalId, resolve)
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      connection.pending.delete(internalId)
      reject(new Error('MCP request timed out after 120s'))
    }, REQUEST_TIMEOUT_MS)
  })

  await connection.clientTransport.send(outgoing)

  try {
    const response = await Promise.race([responsePromise, timeout])
    // Restore the caller's original id (we never leak the internal id out).
    return { ...response, id: originalId } as JSONRPCMessage
  } finally {
    if (timer) clearTimeout(timer)
    connection.pending.delete(internalId)
  }
}

function errorResponse(code: number, errMessage: string, id: number | string | null) {
  return {
    jsonrpc: '2.0' as const,
    error: { code, message: errMessage },
    id,
  }
}

export async function handleMcpRequest(request: Request, server: McpServer): Promise<Response> {
  try {
    const body: unknown = await request.json()
    const connection = await getConnection(server)

    // JSON-RPC 2.0 batch: an array of requests/notifications.
    if (Array.isArray(body)) {
      if (body.length === 0) {
        // Empty batch is an invalid request per spec.
        return Response.json(errorResponse(-32600, 'Invalid Request: empty batch', null), {
          status: 400,
        })
      }

      const responses = await Promise.all(
        body.map(async (entry): Promise<JSONRPCMessage | null> => {
          if (!isJsonRpcObject(entry)) {
            return errorResponse(
              -32600,
              'Invalid Request: batch entry is not a JSON-RPC object',
              null,
            ) as unknown as JSONRPCMessage
          }
          return dispatch(connection, entry)
        }),
      )

      // Omit responses for notifications (null). If every entry was a
      // notification, the batch yields no response body per spec.
      const payload = responses.filter((r): r is JSONRPCMessage => r !== null)
      if (payload.length === 0) return new Response(null, { status: 202 })
      return Response.json(payload)
    }

    if (!isJsonRpcObject(body)) {
      return Response.json(errorResponse(-32600, 'Invalid Request', null), { status: 400 })
    }

    const response = await dispatch(connection, body)
    if (response === null) return new Response(null, { status: 202 })
    return Response.json(response)
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
