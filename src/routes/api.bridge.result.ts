import '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { resolveBridgeResult } from '#/server/bridge'

/** The editor posts tool-call results back here. */
export const Route = createFileRoute('/api/bridge/result')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = (await request.json()) as {
          id?: string
          ok?: boolean
          result?: unknown
          error?: string
        }
        if (!payload.id || typeof payload.ok !== 'boolean') {
          return Response.json({ error: 'id and ok are required' }, { status: 400 })
        }
        const matched = resolveBridgeResult({
          id: payload.id,
          ok: payload.ok,
          result: payload.result,
          error: payload.error,
        })
        return Response.json({ matched })
      },
    },
  },
})
