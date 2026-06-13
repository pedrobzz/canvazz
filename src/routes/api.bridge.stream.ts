import '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { addBridgeClient, removeBridgeClient } from '#/server/bridge'

/** SSE stream pushing MCP tool calls to the live editor tab. */
export const Route = createFileRoute('/api/bridge/stream')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const params = new URL(request.url).searchParams
        // `projects` (comma-separated) is the leader-tab path covering every
        // open project on one stream; `project` (singular) is kept for the
        // single-tab / pre-mesh fallback and external callers.
        const raw = params.get('projects') ?? params.get('project') ?? ''
        const projectIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
        if (projectIds.length === 0) {
          return Response.json(
            { error: 'projects (or project) query param is required' },
            { status: 400 },
          )
        }
        const id = `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const encoder = new TextEncoder()
        let heartbeat: ReturnType<typeof setInterval> | null = null

        const stream = new ReadableStream({
          start(controller) {
            const send = (event: string, data: string) => {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
            }
            addBridgeClient({
              id,
              projectIds,
              send,
              close: () => controller.close(),
            })
            send('hello', JSON.stringify({ id }))
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`))
              } catch {
                if (heartbeat) clearInterval(heartbeat)
                removeBridgeClient(id)
              }
            }, 15_000)
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat)
            removeBridgeClient(id)
          },
        })

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          },
        })
      },
    },
  },
})
