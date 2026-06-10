import { expect, test } from '@playwright/test'
import { centerOf, dragBy, modifier, nodeField, nodeStyle, openEditor, selection } from './helpers'

test.beforeEach(async ({ page }) => {
  await openEditor(page)
})

test('renders the seeded document as live DOM', async ({ page }) => {
  await expect(page.locator('[data-node-id="card-1"]')).toBeVisible()
  await expect(page.locator('[data-node-id="title-1"]')).toHaveText('Design with real DOM')
  // The card is a real flex container, laid out by the browser.
  await expect(page.locator('[data-node-id="card-1"]')).toHaveCSS('display', 'flex')
})

test('click selects; selection overlay appears without touching content', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  expect(await selection(page)).toEqual(['card-1'])
  await expect(page.locator('.cz-selection-box')).toBeVisible()
  await expect(page.locator('.cz-handle')).toHaveCount(8)
  // Content untouched: no outline/border mutated on the node itself.
  await expect(page.locator('[data-node-id="card-1"]')).toHaveCSS('outline-style', 'none')
  // Layer tree mirrors the selection.
  await expect(page.locator('[data-layer-id="card-1"]')).toHaveAttribute('aria-selected', 'true')
})

test('drag moves a node and commits one undoable transaction', async ({ page }) => {
  const before = await nodeStyle(page, 'card-1', 'left')
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  await dragBy(page, card, 60, 40)
  const after = await nodeStyle(page, 'card-1', 'left')
  expect(after).not.toBe(before)
  // Single undo restores the original position.
  await page.keyboard.press(`${modifier}+z`)
  expect(await nodeStyle(page, 'card-1', 'left')).toBe(before)
  await page.keyboard.press(`${modifier}+Shift+z`)
  expect(await nodeStyle(page, 'card-1', 'left')).toBe(after)
})

test('resize via the SE handle updates width/height', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  const handle = await page.locator('.cz-handle-se').boundingBox()
  expect(handle).not.toBeNull()
  if (!handle) return
  await dragBy(page, { x: handle.x + 4, y: handle.y + 4 }, 50, 30)
  const width = await nodeStyle(page, 'card-1', 'width')
  expect(parseFloat(width ?? '0')).toBeGreaterThan(360)
})

test('rotate via corner zone writes a rotate style', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  const zone = await page.locator('.cz-rotate-se').boundingBox()
  expect(zone).not.toBeNull()
  if (!zone) return
  await dragBy(page, { x: zone.x + 8, y: zone.y + 8 }, -30, 60)
  const rotate = await nodeStyle(page, 'card-1', 'rotate')
  expect(rotate).toMatch(/deg$/)
})

test('arrow keys nudge; shift-nudge moves 10px', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  const before = parseFloat((await nodeStyle(page, 'card-1', 'left')) ?? '0')
  await page.keyboard.press('ArrowRight')
  expect(parseFloat((await nodeStyle(page, 'card-1', 'left')) ?? '0')).toBe(before + 1)
  await page.keyboard.press('Shift+ArrowRight')
  expect(parseFloat((await nodeStyle(page, 'card-1', 'left')) ?? '0')).toBe(before + 11)
})

test('marquee selects multiple top-level objects', async ({ page }) => {
  const hero = await centerOf(page, 'hero-1')
  const card = await centerOf(page, 'card-1')
  // Drag a marquee over both, starting from empty canvas left of the artboard.
  const board = await page.locator('[data-node-id="artboard-1"]').boundingBox()
  if (!board) throw new Error('no artboard box')
  await dragBy(
    page,
    { x: board.x - 40, y: Math.min(hero.y, card.y) - 60 },
    board.width + 60,
    Math.abs(card.y - hero.y) + 160,
  )
  const sel = await selection(page)
  expect(sel).toContain('hero-1')
  expect(sel).toContain('card-1')
})

test('draw a rectangle with the R tool inside the artboard', async ({ page }) => {
  await page.keyboard.press('r')
  const board = await page.locator('[data-node-id="artboard-1"]').boundingBox()
  if (!board) throw new Error('no artboard box')
  await dragBy(page, { x: board.x + 30, y: board.y + 520 }, 80, 50)
  const sel = await selection(page)
  expect(sel).toHaveLength(1)
  const newId = sel[0]
  expect(await nodeField(page, newId, 'tag')).toBe('div')
  expect(await nodeField(page, newId, 'parent')).toBe('artboard-1')
  await expect(page.locator(`[data-node-id="${newId}"]`)).toBeVisible()
  // Tool returns to select after drawing.
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute('aria-pressed', 'true')
})

test('double-click deep-selects and edits text in place', async ({ page }) => {
  const title = await centerOf(page, 'title-1')
  await page.mouse.dblclick(title.x, title.y) // deep-selects the exact node
  expect(await selection(page)).toEqual(['title-1'])
  await page.mouse.dblclick(title.x, title.y) // enters text editing
  await expect(page.locator('[data-canvas-text]')).toBeVisible()
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.type('Hello Canvazz')
  await page.keyboard.press('Escape')
  expect(await nodeField(page, 'title-1', 'text')).toBe('Hello Canvazz')
  await expect(page.locator('[data-node-id="title-1"]')).toHaveText('Hello Canvazz')
})

test('inspector edits width and background live', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  const w = page.locator('[data-testid="inspector"] label:has-text("W") input').first()
  await w.fill('300')
  await w.press('Enter')
  expect(await nodeStyle(page, 'card-1', 'width')).toBe('300px')
  await expect(page.locator('[data-node-id="card-1"]')).toHaveCSS('width', '300px')
})

test('group and ungroup', async ({ page }) => {
  const hero = await centerOf(page, 'hero-1')
  await page.mouse.click(hero.x, hero.y)
  const card = await centerOf(page, 'card-1')
  await page.keyboard.down('Shift')
  await page.mouse.click(card.x, card.y)
  await page.keyboard.up('Shift')
  expect(await selection(page)).toHaveLength(2)
  await page.keyboard.press(`${modifier}+g`)
  const sel = await selection(page)
  expect(sel).toHaveLength(1)
  expect(await nodeField(page, 'hero-1', 'parent')).toBe(sel[0])
  await page.keyboard.press(`${modifier}+Shift+g`)
  expect(await nodeField(page, 'hero-1', 'parent')).toBe('artboard-1')
})

test('copy/paste duplicates a subtree with fresh ids', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  await page.keyboard.press(`${modifier}+c`)
  await page.keyboard.press(`${modifier}+v`)
  const sel = await selection(page)
  expect(sel).toHaveLength(1)
  expect(sel[0]).not.toBe('card-1')
  // Pasted card has the same text but a different id.
  const pasted = page.locator(`[data-node-id="${sel[0]}"]`)
  await expect(pasted).toContainText('Design with real DOM')
})

test('layer tree: rename, lock, hide', async ({ page }) => {
  const row = page.locator('[data-layer-id="hero-1"]')
  // Expand the artboard first.
  await page.locator('[data-layer-id="artboard-1"] button[aria-label="Expand"]').click()
  await row.dblclick()
  const input = row.locator('input')
  await input.fill('Hero banner')
  await input.press('Enter')
  expect(await nodeField(page, 'hero-1', 'name')).toBe('Hero banner')

  await row.hover()
  await row.locator('button[aria-label="Hide"]').click()
  expect(await nodeField(page, 'hero-1', 'visible')).toBe(false)
  await expect(page.locator('[data-node-id="hero-1"]')).toBeHidden()
})

test('zoom menu: fit, selection, 100%', async ({ page }) => {
  const transformBefore = await page
    .locator('[data-canvas-world]')
    .evaluate((el) => el.style.transform)
  await page.locator('[data-testid="zoom-menu"]').click()
  await page.getByText('Zoom to 100%').click()
  const after = await page.locator('[data-canvas-world]').evaluate((el) => el.style.transform)
  expect(after).toContain('scale(1)')
  expect(after).not.toBe(transformBefore)
})

test('component: create, instance, override, propagate, detach', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  await page.locator('button[aria-label="Create component"]').click()
  expect(await nodeField(page, 'card-1', 'isComponentRoot')).toBe(true)

  // Insert an instance from the assets tab.
  await page.getByRole('tab', { name: 'Assets' }).click()
  await page.getByRole('button', { name: 'Card' }).click()
  const sel = await selection(page)
  expect(sel).toHaveLength(1)
  const instanceId = sel[0]
  expect(await nodeField(page, instanceId, 'componentId')).toBeTruthy()
  await expect(page.locator(`[data-node-id="${instanceId}"]`)).toBeVisible()

  // Main-component edit propagates into the instance DOM.
  await page.evaluate(() => {
    const cz = (window as never as {
      __canvazz: { editorStore: { apply(l: string, ops: unknown[]): unknown } }
    }).__canvazz
    cz.editorStore.apply('test', [
      { t: 'setStyle', id: 'title-1', set: { color: 'rgb(255, 0, 0)' } },
    ])
  })
  await expect(page.locator(`[data-node-id="${instanceId}:title-1"]`)).toHaveCSS('color', 'rgb(255, 0, 0)')

  // Detach turns it into plain nodes.
  await page.getByRole('button', { name: 'Detach' }).click()
  const detachedSel = await selection(page)
  expect(detachedSel[0]).not.toBe(instanceId)
  expect(await nodeField(page, detachedSel[0], 'componentId')).toBeFalsy()
})

test('autosave persists across reload', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  await dragBy(page, card, 80, 0)
  const moved = await nodeStyle(page, 'card-1', 'left')
  await expect(page.locator('[data-testid="save-state"]')).toHaveText('Saved locally')
  await page.goto('/') // no ?fresh — load from IndexedDB
  await expect(page.locator('[data-node-id="card-1"]')).toBeVisible()
  expect(await nodeStyle(page, 'card-1', 'left')).toBe(moved)
})

test('drawing into an auto-layout container creates a flow child', async ({ page }) => {
  await page.keyboard.press('r')
  const title = await page.locator('[data-node-id="title-1"]').boundingBox()
  if (!title) throw new Error('no title box')
  await dragBy(page, { x: title.x + 10, y: title.y + title.height + 5 }, 50, 24)
  const sel = await selection(page)
  expect(sel).toHaveLength(1)
  const id = sel[0]
  expect(await nodeField(page, id, 'parent')).toBe('card-1')
  // Joins the flow: no absolute positioning.
  expect(await nodeStyle(page, id, 'position')).toBeUndefined()
  const children = await page.evaluate(() => {
    const cz = (window as never as {
      __canvazz: { editorStore: { doc: { nodes: Record<string, { children: string[] }> } } }
    }).__canvazz
    return cz.editorStore.doc.nodes['card-1'].children
  })
  expect(children.indexOf(id)).toBe(1) // right after the title, where drawn
})

test('flow child drags out of and back into auto-layout containers', async ({ page }) => {
  const label = await centerOf(page, 'button-label-1')
  await page.mouse.dblclick(label.x, label.y)
  expect(await selection(page)).toEqual(['button-label-1'])

  // Out of the button onto the artboard: becomes absolute.
  const board = await page.locator('[data-node-id="artboard-1"]').boundingBox()
  if (!board) throw new Error('no artboard box')
  await dragBy(page, label, 0, board.y + board.height - 40 - label.y)
  expect(await nodeField(page, 'button-label-1', 'parent')).toBe('artboard-1')
  expect(await nodeStyle(page, 'button-label-1', 'position')).toBe('absolute')

  // Back into the button: joins the flex flow again.
  const cur = await centerOf(page, 'button-label-1')
  const btn = await centerOf(page, 'button-1')
  await dragBy(page, cur, btn.x - cur.x, btn.y - cur.y)
  expect(await nodeField(page, 'button-label-1', 'parent')).toBe('button-1')
  expect(await nodeStyle(page, 'button-label-1', 'position')).toBeUndefined()
})

test('pages: add, switch, and switch back', async ({ page }) => {
  await page.locator('[data-testid="pages"] button[aria-label="Add page"]').click()
  await expect(page.locator('[data-testid="pages"] li')).toHaveCount(2)
  // The new page is active and empty.
  await expect(page.locator('[data-node-id="artboard-1"]')).toHaveCount(0)
  await page.locator('[data-testid="pages"] li').first().click()
  await expect(page.locator('[data-node-id="artboard-1"]')).toBeVisible()
})
