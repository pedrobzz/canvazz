import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/** Create a fresh project (deterministic seed document) and open the editor. */
export async function openEditor(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New file' }).click()
  await expect(page.locator('[data-node-id="artboard-1"]')).toBeVisible()
  // Initial zoom-to-fit settles camera; wait for the world transform to apply.
  await page.waitForTimeout(120)
  await page.evaluate(() => {
    const cz = (window as never as { __canvazz: { editorStore: { setUi(p: object): void } } }).__canvazz
    cz.editorStore.setUi({ snapping: false })
  })
}

export function nodeStyle(page: Page, id: string, prop: string): Promise<string | undefined> {
  return page.evaluate(
    ([nodeId, styleProp]) => {
      const cz = (window as never as {
        __canvazz: { editorStore: { doc: { nodes: Record<string, { style: Record<string, string> }> } } }
      }).__canvazz
      return cz.editorStore.doc.nodes[nodeId]?.style[styleProp]
    },
    [id, prop] as const,
  )
}

export function nodeField(page: Page, id: string, field: string): Promise<unknown> {
  return page.evaluate(
    ([nodeId, key]) => {
      const cz = (window as never as {
        __canvazz: { editorStore: { doc: { nodes: Record<string, Record<string, unknown>> } } }
      }).__canvazz
      return cz.editorStore.doc.nodes[nodeId]?.[key]
    },
    [id, field] as const,
  )
}

export function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cz = (window as never as { __canvazz: { editorStore: { ui: { selection: string[] } } } }).__canvazz
    return cz.editorStore.ui.selection
  })
}

/** Center of a canvas node in page coordinates. */
export async function centerOf(page: Page, nodeId: string) {
  const box = await page.locator(`[data-node-id="${nodeId}"]`).boundingBox()
  if (!box) throw new Error(`No bounding box for ${nodeId}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Several intermediate moves so the rAF-coalesced controller sees motion.
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(from.x + (dx * i) / 5, from.y + (dy * i) / 5)
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
}

export const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Set the selection directly (for tests that aren't about picking). */
export function select(page: Page, ids: string[]): Promise<void> {
  return page.evaluate((sel) => {
    const cz = (window as never as { __canvazz: { editorStore: { setSelection(ids: string[]): void } } }).__canvazz
    cz.editorStore.setSelection(sel)
  }, ids)
}
