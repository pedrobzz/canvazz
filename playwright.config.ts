import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  // The MCP bridge dispatches to the most recent editor tab, and visual
  // snapshots depend on exclusive camera state — run serially.
  workers: 1,
  fullyParallel: false,
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
    port: 3100,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
