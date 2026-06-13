/**
 * Compile entry for the standalone binary (`bun build --compile`).
 *
 * Unlike bin/canvazz.mjs (which reads dist/ from the installed npm package),
 * this entry statically imports the built SSR server and every client asset so
 * `bun build --compile` embeds them into a single self-contained executable —
 * no Node, no node_modules, no dist/ on the user's machine.
 *
 *   canvazz [--port 47823] [--db path] [--no-open]
 */
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { serve } from 'srvx'
import appServer from '../dist/server/server.js'
import { assets } from '../dist/embedded-assets.mjs'

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
const dbFlag = flag('--db')
if (dbFlag) process.env.CANVAZZ_DB = resolve(dbFlag)

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

function mimeFor(pathname) {
  const i = pathname.lastIndexOf('.')
  return (i >= 0 && MIME[pathname.slice(i).toLowerCase()]) || 'application/octet-stream'
}

/** Serve an embedded client asset, or undefined to fall through to SSR. */
function staticResponse(pathname) {
  const file = assets[pathname]
  if (!file) return undefined
  const headers = { 'content-type': mimeFor(pathname) }
  // Hashed build assets are immutable; everything else stays revalidatable.
  if (pathname.startsWith('/assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  }
  return new Response(Bun.file(file), { headers })
}

const server = serve({
  port,
  fetch(request) {
    const { pathname } = new URL(request.url)
    return staticResponse(pathname) ?? appServer.fetch(request)
  },
})
await server.ready()

const url = `http://localhost:${port}`
console.log(`canvazz running at ${url}`)
console.log(`project store: ${process.env.CANVAZZ_DB ?? join(homedir(), '.canvazz', 'database.db')}`)
console.log(`mcp endpoint:  ${url}/mcp`)

if (!args.includes('--no-open')) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { shell: process.platform === 'win32', stdio: 'ignore' }).on('error', () => {})
}
