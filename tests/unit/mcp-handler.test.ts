import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { handleMcpRequest } from '#/utils/mcp-handler'

/**
 * Build a fresh McpServer fixture with a couple of tools. Each handler gets a
 * unique server instance so the persistent-connection WeakMap in the handler is
 * isolated per test.
 *
 * - `echo` returns its input immediately.
 * - `slow` waits `delayMs` before answering, so we can prove that concurrent
 *   requests interleave over the single persistent transport rather than
 *   serializing.
 */
function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' })

  server.registerTool(
    'echo',
    { description: 'Echo back text', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )

  server.registerTool(
    'slow',
    { description: 'Echo after a delay', inputSchema: { text: z.string(), delayMs: z.number() } },
    async ({ text, delayMs }) => {
      await new Promise((r) => setTimeout(r, delayMs))
      return { content: [{ type: 'text', text }] }
    },
  )

  return server
}

function post(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function callMessage(id: number | string, text: string, tool = 'echo', extra?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call',
    params: { name: tool, arguments: { text, ...extra } },
  }
}

interface RpcResult {
  id?: number | string | null
  result?: { content?: Array<{ text?: string }> }
  error?: { code: number; message: string }
}

/** Pull the text payload out of a tools/call result. */
function resultText(message: RpcResult | undefined): string | undefined {
  return message?.result?.content?.[0]?.text
}

let server: McpServer

beforeEach(() => {
  server = makeServer()
})

afterEach(async () => {
  await server.close()
})

describe('handleMcpRequest — single request', () => {
  it('answers a tools/call and preserves the request id', async () => {
    const res = await handleMcpRequest(post(callMessage(42, 'hello')), server)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(42)
    expect(resultText(body)).toBe('hello')
  })

  it('returns 202 with no body for a notification (no id)', async () => {
    const res = await handleMcpRequest(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      server,
    )
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('does not 500 with "Already connected" on rapid sequential calls', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await handleMcpRequest(post(callMessage(i, `seq-${i}`)), server)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(i)
      expect(resultText(body)).toBe(`seq-${i}`)
    }
  })
})

describe('handleMcpRequest — concurrency (issue #1)', () => {
  it('10 truly parallel tools/call POSTs all succeed with no -32603', async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      handleMcpRequest(post(callMessage(i, `parallel-${i}`)), server),
    )
    const results = await Promise.all(requests)

    for (let i = 0; i < results.length; i++) {
      const res = results[i]
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.error).toBeUndefined()
      expect(body.id).toBe(i)
      expect(resultText(body)).toBe(`parallel-${i}`)
    }
  })

  it('routes responses to the right caller when a slow call overlaps a fast one', async () => {
    const slow = handleMcpRequest(post(callMessage(1, 'slow-result', 'slow', { delayMs: 60 })), server)
    const fast = handleMcpRequest(post(callMessage(2, 'fast-result', 'echo')), server)

    const [slowRes, fastRes] = await Promise.all([slow, fast])
    const slowBody = await slowRes.json()
    const fastBody = await fastRes.json()

    expect(slowBody.id).toBe(1)
    expect(resultText(slowBody)).toBe('slow-result')
    expect(fastBody.id).toBe(2)
    expect(resultText(fastBody)).toBe('fast-result')
  })

  it('two concurrent clients reusing the same numeric id do not cross-talk', async () => {
    // Both callers use id=7. Internal id rewriting must keep them separate, and
    // the slower one must still get ITS payload (not the fast one's).
    const a = handleMcpRequest(post(callMessage(7, 'client-A', 'slow', { delayMs: 50 })), server)
    const b = handleMcpRequest(post(callMessage(7, 'client-B', 'echo')), server)

    const [aRes, bRes] = await Promise.all([a, b])
    const aBody = await aRes.json()
    const bBody = await bRes.json()

    expect(aBody.id).toBe(7)
    expect(bBody.id).toBe(7)
    expect(resultText(aBody)).toBe('client-A')
    expect(resultText(bBody)).toBe('client-B')
  })
})

describe('handleMcpRequest — batches (issue #2)', () => {
  it('returns an array of 2 results for a batch of 2 valid calls', async () => {
    const res = await handleMcpRequest(
      post([callMessage(1, 'one'), callMessage(2, 'two')]),
      server,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as RpcResult[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)

    const byId = new Map(body.map((m) => [m.id, m]))
    expect(resultText(byId.get(1))).toBe('one')
    expect(resultText(byId.get(2))).toBe('two')
  })

  it('matches results to ids regardless of completion order', async () => {
    // First entry is slow, second is fast. Responses must still be id-keyed.
    const res = await handleMcpRequest(
      post([callMessage(1, 'slow-one', 'slow', { delayMs: 50 }), callMessage(2, 'fast-two', 'echo')]),
      server,
    )
    const body = (await res.json()) as RpcResult[]
    const byId = new Map(body.map((m) => [m.id, m]))
    expect(resultText(byId.get(1))).toBe('slow-one')
    expect(resultText(byId.get(2))).toBe('fast-two')
  })

  it('returns a per-entry error for an invalid entry in a batch', async () => {
    const res = await handleMcpRequest(post([callMessage(1, 'valid'), 'not-an-object']), server)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RpcResult[]
    expect(body).toHaveLength(2)

    const valid = body.find((m) => m.id === 1)
    expect(resultText(valid)).toBe('valid')

    const invalid = body.find((m) => m.error)
    expect(invalid?.error?.code).toBe(-32600)
  })

  it('returns -32600 for an empty batch', async () => {
    const res = await handleMcpRequest(post([]), server)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe(-32600)
    expect(body.id).toBeNull()
  })

  it('omits notification entries from the batch response', async () => {
    const res = await handleMcpRequest(
      post([
        callMessage(1, 'kept'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]),
      server,
    )
    const body = (await res.json()) as RpcResult[]
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe(1)
  })

  it('returns 202 when a batch contains only notifications', async () => {
    const res = await handleMcpRequest(
      post([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
      ]),
      server,
    )
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })
})

describe('handleMcpRequest — malformed input', () => {
  it('returns -32600 for a non-array, non-object body', async () => {
    const res = await handleMcpRequest(post('just a string'), server)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe(-32600)
  })
})
