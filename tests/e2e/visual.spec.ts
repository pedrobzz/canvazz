import { expect, test } from '@playwright/test'
import { openEditor } from './helpers'
import type { Page } from '@playwright/test'

/** Visual regression of the canvas at multiple zoom levels. */

async function setCamera(page: Page, x: number, y: number, scale: number) {
  await page.evaluate(
    ([cx, cy, cs]) => {
      const cz = (window as never as {
        __canvazz: { cameraStore: { set(c: { x: number; y: number; scale: number }): void } }
      }).__canvazz
      cz.cameraStore.set({ x: cx, y: cy, scale: cs })
    },
    [x, y, scale] as const,
  )
  await page.waitForTimeout(150)
}

test.beforeEach(async ({ page }) => {
  await openEditor(page)
  // Deselect and settle.
  await page.keyboard.press('Escape')
})

for (const zoom of [0.5, 1, 2]) {
  test(`canvas snapshot at ${zoom * 100}% zoom`, async ({ page }) => {
    await setCamera(page, 80 - 120 * zoom, 60 - 80 * zoom, zoom)
    await expect(page.locator('[data-canvas]')).toHaveScreenshot(`canvas-zoom-${zoom * 100}.png`, {
      // Toolbar overlays the canvas; mask it so chrome changes don't fail design diffs.
      mask: [page.locator('[data-testid="toolbar"]')],
    })
  })
}
