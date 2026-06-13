import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  // The MCP bridge dispatches to the most recent editor tab, and visual
  // snapshots depend on exclusive camera state — run serially.
  workers: 1,
  fullyParallel: false,
  // Shared CI runners vary wildly under load (the 10k-node perf smoke has been
  // seen at 432ms and 754ms for the same mount), which flakes timing-sensitive
  // tests near their thresholds. Retry on CI so a momentary spike doesn't fail
  // the run; a genuinely broken test still fails all attempts.
  retries: process.env.CI ? 2 : 0,
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: 'http://localhost:3100',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bunx vite dev --port 3100',
    // Throwaway project store; never the real ~/.canvazz database.
    env: { CANVAZZ_DB: join(tmpdir(), `canvazz-e2e-${Date.now()}.db`) },
    port: 3100,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
