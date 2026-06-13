import { expect, test } from '@playwright/test'
import { centerOf, dragBy, modifier, nodeField, nodeStyle, openEditor, select, selection } from './helpers'

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

test('text edit commits when clicking away (blur), not only on Escape', async ({ page }) => {
  const title = await centerOf(page, 'title-1')
  await page.mouse.dblclick(title.x, title.y) // deep-select
  await page.mouse.dblclick(title.x, title.y) // edit
  await expect(page.locator('[data-canvas-text]')).toBeVisible()
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.type('Committed on blur')
  // Click empty canvas: the controller clears editingTextId on pointerdown,
  // unmounting the editor; the edit must still commit from the captured node.
  await page.mouse.click(title.x + 320, title.y + 320)
  expect(await nodeField(page, 'title-1', 'text')).toBe('Committed on blur')
  await expect(page.locator('[data-node-id="title-1"]')).toHaveText('Committed on blur')
})

test('inspector edits width and background live', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  const w = page.locator('input[aria-label="Width"]')
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
  await expect(page.locator('[data-testid="save-state"]')).toHaveText('Saved')
  await page.reload() // load the same project back from the libsql store
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

test('layer tree shows auto-layout children in flow order and drags WYSIWYG', async ({ page }) => {
  await page.locator('[data-layer-id="artboard-1"] button[aria-label="Expand"]').click()
  await page.locator('[data-layer-id="card-1"] button[aria-label="Expand"]').click()
  const order = await page.$$eval('[data-layer-id]', (els) =>
    els.map((e) => e.getAttribute('data-layer-id')),
  )
  // Flex children listed in document order (= visual order)…
  expect(order.indexOf('title-1')).toBeLessThan(order.indexOf('body-1'))
  expect(order.indexOf('body-1')).toBeLessThan(order.indexOf('button-1'))
  // …while absolute artboard children stay z-ordered (front first).
  expect(order.indexOf('card-1')).toBeLessThan(order.indexOf('hero-1'))
})

test('inspector color swatch stays compact (no row overflow)', async ({ page }) => {
  const card = await centerOf(page, 'card-1')
  await page.mouse.click(card.x, card.y)
  const swatch = page.locator('[data-section="background"] input[type="color"]').first()
  const box = await swatch.boundingBox()
  expect(box?.width ?? 999).toBeLessThanOrEqual(32)
  const overflow = await page
    .locator('[data-testid="inspector"]')
    .evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(overflow).toBe(false)
})

test('W/H sizing modes: fill is direction-aware, values accept %', async ({ page }) => {
  // Button is a flow child of the flex-COLUMN card.
  await select(page, ['button-1'])

  const pickMode = async (axis: 'W' | 'H', mode: string) => {
    await page.locator(`button[aria-label="${axis} sizing mode"]`).click()
    // Wait for the Radix menu to finish opening before clicking an item, and
    // scope the item to that menu. Under CI load a click could otherwise land
    // mid-open-animation and never select, leaving the mode unchanged.
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const item = menu.getByRole('menuitem', { name: mode })
    await expect(item).toBeVisible()
    await item.click()
    // Radix unmounts menus async; wait for full close so the next dropdown
    // click can't land on this menu's exiting items.
    await expect(page.getByRole('menu')).toHaveCount(0)
  }

  // W: Fill in a column parent = stretch on the cross axis, NOT flex-grow.
  await pickMode('W', 'Fill container')
  expect(await nodeStyle(page, 'button-1', 'align-self')).toBe('stretch')
  expect(await nodeStyle(page, 'button-1', 'flex-grow')).toBeUndefined()

  // H: Fill in a column parent = main axis = flex-grow.
  await pickMode('H', 'Fill container')
  expect(await nodeStyle(page, 'button-1', 'flex-grow')).toBe('1')
  expect(await nodeStyle(page, 'button-1', 'height')).toBeUndefined()

  // Typing a percentage commits it as-is.
  const wInput = page.locator('input[aria-label="Width"]')
  await wInput.fill('50%')
  await wInput.press('Enter')
  expect(await nodeStyle(page, 'button-1', 'width')).toBe('50%')

  // H: Fit hugs content (height removed, grow cleared).
  await pickMode('H', 'Fit content')
  expect(await nodeStyle(page, 'button-1', 'flex-grow')).toBeUndefined()
  expect(await nodeStyle(page, 'button-1', 'height')).toBeUndefined()
})

test('resize handle works on flow children and pins their size', async ({ page }) => {
  await select(page, ['button-1'])
  const handle = await page.locator('.cz-handle-e').boundingBox()
  expect(handle).not.toBeNull()
  if (!handle) return
  await dragBy(page, { x: handle.x + 4, y: handle.y + 4 }, -60, 0)
  const width = await nodeStyle(page, 'button-1', 'width')
  expect(width).toMatch(/px$/)
  expect(parseFloat(width ?? '999')).toBeLessThan(287)
})

test('instance inspector shows inherited definition styles', async ({ page }) => {
  // Make the button a component, place an instance, select it.
  await select(page, ['button-1'])
  await page.locator('button[aria-label="Create component"]').click()
  await page.getByRole('tab', { name: 'Assets' }).click()
  await page.getByRole('button', { name: 'Button', exact: true }).click()
  const sel = await selection(page)
  const instanceId = sel[0]
  expect(await nodeField(page, instanceId, 'componentId')).toBeTruthy()
  // Background Fill shows the definition's background, not "none".
  const fillValue = page.locator('[data-section="background"] input[type="color"]').first()
  await expect(fillValue).toHaveValue('#4f8ef7')
})

test('color tokens recolor every usage instantly and export standalone', async ({ page }) => {
  await page.evaluate(() => {
    const cz = (window as never as { __canvazz: { editorStore: { apply(l: string, ops: unknown[]): unknown } } }).__canvazz
    cz.editorStore.apply('Add token', [{ t: 'setToken', name: 'brand', value: '#ff0000' }])
    cz.editorStore.apply('Use token', [
      { t: 'setStyle', id: 'hero-1', set: { background: null, 'background-color': 'var(--brand)' } },
    ])
  })
  await expect(page.locator('[data-node-id="hero-1"]')).toHaveCSS('background-color', 'rgb(255, 0, 0)')
  // One token edit recolors every usage.
  await page.evaluate(() => {
    const cz = (window as never as { __canvazz: { editorStore: { apply(l: string, ops: unknown[]): unknown } } }).__canvazz
    cz.editorStore.apply('Edit token', [{ t: 'setToken', name: 'brand', value: '#00ff00' }])
  })
  await expect(page.locator('[data-node-id="hero-1"]')).toHaveCSS('background-color', 'rgb(0, 255, 0)')
  // Exports embed the token so the HTML stands alone.
  const html = await page.evaluate(async () => {
    // Vite dev-server module path; not resolvable by the test's TS project.
    const mod = (await import(/* @vite-ignore */ '/src/editor/compiler/export.ts' as string)) as {
      exportHtml: (doc: unknown, id: string) => string
    }
    const cz = (window as never as { __canvazz: { editorStore: { doc: unknown } } }).__canvazz
    return mod.exportHtml(cz.editorStore.doc, 'hero-1')
  })
  expect(html).toContain('--brand: #00ff00')
  expect(html).toContain('var(--brand)')
})

test('create component moves main to the Design System page, leaves instance', async ({ page }) => {
  await select(page, ['card-1'])
  await page.locator('button[aria-label="Create component"]').click()
  const onDs = await page.evaluate(() => {
    const cz = (window as never as {
      __canvazz: { editorStore: { doc: { pages: Array<{ id: string; children: string[] }> } } }
    }).__canvazz
    return cz.editorStore.doc.pages.find((p) => p.id === 'page_design_system')?.children.includes('card-1')
  })
  expect(onDs).toBe(true)
  // The replacement instance renders in place, linked to the component.
  const sel = await selection(page)
  expect(await nodeField(page, sel[0], 'componentId')).toBeTruthy()
  const repl = page.locator(`[data-node-id="${sel[0]}"]`)
  await expect(repl).toBeVisible()
  await expect(repl).toContainText('Design with real DOM')
  // The Design System page is a real page: switch to it and see the main.
  await page.getByText('Design System').click()
  await expect(page.locator('[data-node-id="card-1"]')).toBeVisible()
})

test('constraints: right-pin re-anchors without moving the box', async ({ page }) => {
  await select(page, ['card-1'])
  const before = await page.locator('[data-node-id="card-1"]').boundingBox()
  // Position selects: [H anchor, V anchor] (absolute toggle lives in the header)
  await page.locator('[data-section="position"] select').nth(0).selectOption('right')
  expect(await nodeStyle(page, 'card-1', 'right')).toMatch(/px$/)
  expect(await nodeStyle(page, 'card-1', 'left')).toBeUndefined()
  const after = await page.locator('[data-node-id="card-1"]').boundingBox()
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2)
  // And back to left-pin.
  await page.locator('[data-section="position"] select').nth(0).selectOption('left')
  expect(await nodeStyle(page, 'card-1', 'left')).toMatch(/px$/)
  expect(await nodeStyle(page, 'card-1', 'right')).toBeUndefined()
})

test('rotate 90 and flip actions write rotate/scale styles', async ({ page }) => {
  await select(page, ['hero-1'])
  await page.getByRole('button', { name: 'Rotate 90°' }).click()
  expect(await nodeStyle(page, 'hero-1', 'rotate')).toBe('90deg')
  await page.getByRole('button', { name: 'Flip horizontal' }).click()
  expect(await nodeStyle(page, 'hero-1', 'scale')).toBe('-1 1')
  await page.getByRole('button', { name: 'Flip vertical' }).click()
  expect(await nodeStyle(page, 'hero-1', 'scale')).toBe('-1 -1')
  await page.getByRole('button', { name: 'Flip horizontal' }).click()
  expect(await nodeStyle(page, 'hero-1', 'scale')).toBe('1 -1')
})
