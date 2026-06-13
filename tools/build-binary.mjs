/**
 * Compiles the standalone darwin-arm64 (Apple Silicon) binary.
 *
 * Prereqs (run by `bun run build:binary`):
 *   1. `vite build`                  -> dist/server + dist/client
 *   2. `bun tools/gen-embedded-assets.mjs` -> dist/embedded-assets.mjs
 *
 * Produces ./canvazz-darwin-arm64 (+ .sha256). darwin-arm64 only by design —
 * other platforms build from source (see README).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'bin', 'canvazz.bundle.mjs')
const out = join(root, 'canvazz-darwin-arm64')

if (!existsSync(join(root, 'dist', 'embedded-assets.mjs'))) {
  console.error('[build-binary] dist/embedded-assets.mjs missing — run the full `bun run build:binary`.')
  process.exit(1)
}

const args = [
  'build',
  '--compile',
  '--target=bun-darwin-arm64',
  entry,
  '--outfile',
  out,
]

console.log(`[build-binary] bun ${args.join(' ')}`)
const res = spawnSync('bun', args, { stdio: 'inherit', cwd: root })
if (res.status !== 0) {
  console.error('[build-binary] compile failed')
  process.exit(res.status ?? 1)
}

const buf = readFileSync(out)
const sha = createHash('sha256').update(buf).digest('hex')
writeFileSync(`${out}.sha256`, `${sha}  canvazz-darwin-arm64\n`)
const mb = (statSync(out).size / 1024 / 1024).toFixed(1)
console.log(`[build-binary] ${out} (${mb} MB)`)
console.log(`[build-binary] sha256 ${sha}`)
