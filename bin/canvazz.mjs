#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { serve } from 'srvx'
import { serveStatic } from 'srvx/static'

/**
 * Canvazz CLI: runs the built app (SSR server + client assets + MCP endpoint)
 * straight from the npm package. Documents persist to ~/.canvazz/database.db
 * unless --db / CANVAZZ_DB points elsewhere.
 *
 *   npx canvazz [--port 47823] [--db path] [--no-open]
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`canvazz — local-first, AI-first design editor

Usage: canvazz [options]

Options:
  -p, --port <port>  Port to listen on (default 47823 or $PORT)
      --db <path>    Project database file (default ~/.canvazz/database.db)
      --no-open      Do not open the browser
  -h, --help         Show this help

MCP: claude mcp add --transport http canvazz http://localhost:<port>/mcp`)
  process.exit(0)
}

function flag(...names) {
  for (const name of names) {
    const i = args.indexOf(name)
    if (i >= 0) return args[i + 1]
  }
  return undefined
}

const port = Number(flag('--port', '-p') ?? process.env.PORT ?? 47823)
const db = flag('--db')
if (db) process.env.CANVAZZ_DB = resolve(db)

const serverEntry = join(root, 'dist/server/server.js')
if (!existsSync(serverEntry)) {
  console.error('Build output missing. Run `pnpm build` first (dist/server/server.js).')
  process.exit(1)
}

const entry = await import(pathToFileURL(serverEntry).href)

const server = serve({
  port,
  fetch: entry.default.fetch,
  middleware: [serveStatic({ dir: join(root, 'dist/client') })],
})
await server.ready()

const url = `http://localhost:${port}`
console.log(`canvazz running at ${url}`)
console.log(`project store: ${process.env.CANVAZZ_DB ?? join(process.env.HOME ?? '~', '.canvazz', 'database.db')}`)
console.log(`mcp endpoint:  ${url}/mcp`)

if (!args.includes('--no-open')) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { shell: process.platform === 'win32', stdio: 'ignore' }).on('error', () => {})
}
