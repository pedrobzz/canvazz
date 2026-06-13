import { expect, test } from '@playwright/test'

/**
 * Performance harness. Headless CI boxes are slow and noisy, so thresholds
 * are intentionally generous — they catch order-of-magnitude regressions
 * (rendering through React per frame, layout thrash), not 10% drift.
 */

interface PerfStats {
  nodes: number
  mountMs: number
  domNodes: number
}

async function loadPerf(page: import('@playwright/test').Page, n: number): Promise<PerfStats> {
  await page.goto(`/perf?n=${n}`)
  await page.waitForFunction(() => (window as never as { __perfStats?: object }).__perfStats, null, {
    timeout: 60_000,
  })
  return page.evaluate(() => (window as never as { __perfStats: PerfStats }).__perfStats)
}

test('1k nodes: mounts fast and pans at interactive frame rates', async ({ page }) => {
  const stats = await loadPerf(page, 1000)
  expect(stats.domNodes).toBeGreaterThanOrEqual(1000)
  expect(stats.mountMs).toBeLessThan(4000)

  // Measure frame times while panning with wheel events (camera writes
  // bypass React entirely; this asserts the hot path stays hot).
  const frames = await page.evaluate(async () => {
    const canvas = document.querySelector('[data-canvas]')
    if (!canvas) throw new Error('no canvas')
    const times: number[] = []
    let last = performance.now()
    let running = true
    const tick = () => {
      const now = performance.now()
      times.push(now - last)
      last = now
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 7, deltaY: 5, bubbles: true, cancelable: true }),
      )
      await new Promise((r) => requestAnimationFrame(r))
    }
    running = false
    return times.slice(2) // skip warmup
  })
  const sorted = [...frames].sort((a, b) => a - b)
  const p75 = sorted[Math.floor(sorted.length * 0.75)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  console.log(`pan frames: p75=${p75.toFixed(1)}ms p95=${p95.toFixed(1)}ms n=${frames.length}`)
  expect(p75).toBeLessThan(20) // ~50fps+ at p75 even on CI hardware
  expect(p95).toBeLessThan(40)
})

test('1k nodes: selection responds within the INP budget', async ({ page }) => {
  await loadPerf(page, 1000)
  const duration = await page.evaluate(async () => {
    const el = document.querySelector('[data-node-id="pn_0_5"]')
    if (!el) throw new Error('missing node')
    const r = el.getBoundingClientRect()
    const opts = {
      bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }
    const start = performance.now()
    const target = document.elementFromPoint(opts.clientX, opts.clientY)
    target?.dispatchEvent(new PointerEvent('pointerdown', opts))
    window.dispatchEvent(new PointerEvent('pointerup', opts))
    // Next paint after the interaction = INP-style measurement.
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    return performance.now() - start
  })
  console.log(`selection interaction-to-paint: ${duration.toFixed(1)}ms`)
  expect(duration).toBeLessThan(200)
})

test('10k nodes: renders and stays interactive (smoke)', async ({ page }) => {
  test.setTimeout(120_000)
  const stats = await loadPerf(page, 10_000)
  expect(stats.domNodes).toBeGreaterThanOrEqual(10_000)
  console.log(`10k mount: ${stats.mountMs.toFixed(0)}ms`)

  // A selection still lands within a generous interactive budget.
  const duration = await page.evaluate(async () => {
    const el = document.querySelector('[data-node-id="pn_0_5"]')
    if (!el) throw new Error('missing node')
    const r = el.getBoundingClientRect()
    const opts = {
      bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }
    const start = performance.now()
    const target = document.elementFromPoint(opts.clientX, opts.clientY)
    target?.dispatchEvent(new PointerEvent('pointerdown', opts))
    window.dispatchEvent(new PointerEvent('pointerup', opts))
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    return performance.now() - start
  })
  console.log(`10k selection interaction-to-paint: ${duration.toFixed(1)}ms`)
  // Shared CI runners are load-variable (~2x): the same interaction has measured
  // ~470ms locally and 520-600ms on a loaded runner. 750ms still catches a real
  // regression (the overlay is imperative, so this stays well under it) without
  // flaking the run on infra noise.
  expect(duration).toBeLessThan(750)
})
