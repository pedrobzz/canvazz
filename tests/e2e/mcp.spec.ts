import { expect, test } from '@playwright/test'
import { openEditor } from './helpers'
import type { Page } from '@playwright/test'

/**
 * End-to-end MCP contract: HTTP tool call -> SSE bridge -> live editor ->
 * result. The page must stay open; it is the execution environment.
 */

let rpcId = 100

async function callToolRaw(page: Page, name: string, args: Record<string, unknown>) {
  const response = await page.request.post('/mcp', {
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    result: { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }
  }
  return body.result
}

function openProjectId(page: Page) {
  return page.evaluate(
    () => (window as never as { __canvazz: { projectId: string } }).__canvazz.projectId,
  )
}

/** Call a canvas tool against the project open in this page. */
async function callTool(page: Page, name: string, args: Record<string, unknown>) {
  return callToolRaw(page, name, { project: await openProjectId(page), ...args })
}

function textPayload(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((c) => c.type === 'text')?.text ?? ''
  return text.startsWith('Error') ? text : (JSON.parse(text) as Record<string, unknown>)
}

test.beforeEach(async ({ page }) => {
  await openEditor(page)
  // Wait for the SSE bridge to connect.
  await expect(page.getByText('MCP live')).toBeVisible({ timeout: 10_000 })
})

test('tools are project-scoped: list_projects sees the open tab, bad refs fail', async ({ page }) => {
  const projectId = await openProjectId(page)
  const listed = textPayload(await callToolRaw(page, 'list_projects', {})) as {
    projects: Array<{ id: string; open: boolean }>
  }
  expect(listed.projects.find((p) => p.id === projectId)?.open).toBe(true)

  const unknown = await callToolRaw(page, 'get_basic_info', { project: 'nope_404' })
  expect(unknown.isError).toBe(true)
  expect(unknown.content[0].text).toContain('Unknown project')
})

test('get_basic_info reflects the live document', async ({ page }) => {
  const info = textPayload(await callTool(page, 'get_basic_info', {})) as {
    artboards: Array<{ id: string }>
    nodeCount: number
  }
  expect(info.artboards[0].id).toBe('artboard-1')
  expect(info.nodeCount).toBe(7)
})

test('write_html sanitizes, renders live, selects, and is undoable', async ({ page }) => {
  const result = textPayload(
    await callTool(page, 'write_html', {
      targetId: 'artboard-1',
      html: `<div data-cz-name="Evil card" style="position:absolute;left:30px;top:560px;width:200px;height:60px;background-color:#10b981;border-radius:8px" onclick="alert(1)"><script>window.hacked=true</script><span style="color:white">safe text</span><iframe src="https://evil.example"></iframe></div>`,
    }),
  ) as { ok: boolean; changedIds: string[]; dropped: string[] }

  expect(result.ok).toBe(true)
  expect(result.dropped).toEqual(expect.arrayContaining(['attr:onclick', 'tag:script', 'tag:iframe']))
  const newId = result.changedIds[0]

  // Renders live on canvas, selected, with the AI indicator pulsing.
  const el = page.locator(`[data-node-id="${newId}"]`)
  await expect(el).toBeVisible()
  await expect(el).toHaveText('safe text')
  expect(await el.getAttribute('onclick')).toBeNull()
  expect(await page.evaluate(() => (window as never as { hacked?: boolean }).hacked)).toBeUndefined()
  await expect(page.locator('.cz-ai-outline').first()).toBeVisible()

  // Logged as an AI edit.
  await page.getByRole('tab', { name: 'Log' }).click()
  await expect(page.locator('[data-testid="command-log"]')).toContainText('AI: write html')

  // Undo via MCP removes it.
  textPayload(await callTool(page, 'undo', {}))
  await expect(el).toHaveCount(0)
})

test('round trip: write_html -> get_html -> identical re-import', async ({ page }) => {
  const written = textPayload(
    await callTool(page, 'write_html', {
      targetId: 'artboard-1',
      html: `<div data-cz-id="rt-1" data-cz-name="RT" style="position:absolute;left:10px;top:600px;display:flex;gap:4px"><span data-cz-id="rt-2" data-cz-name="A">A</span><span data-cz-id="rt-3" data-cz-name="B">B</span></div>`,
    }),
  ) as { changedIds: string[] }
  expect(written.changedIds[0]).toBe('rt-1')

  const html = (textPayload(await callTool(page, 'get_html', { id: 'rt-1' })) as { html: string }).html
  expect(html).toContain('data-cz-id="rt-1"')
  expect(html).toContain('data-cz-name="RT"')
  expect(html).toContain('display: flex')

  const jsx = (textPayload(await callTool(page, 'get_jsx', { id: 'rt-1' })) as { jsx: string }).jsx
  expect(jsx).toContain('export function RT()')
  expect(jsx).toContain("display: 'flex'")
})

test('update_styles + set_text_content + move_nodes edit targeted nodes', async ({ page }) => {
  const styled = textPayload(
    await callTool(page, 'update_styles', {
      updates: [{ id: 'hero-1', set: { 'background-color': '#0f172a', background: null } }],
    }),
  ) as { ok: boolean; rejected: string[] }
  expect(styled.ok).toBe(true)
  await expect(page.locator('[data-node-id="hero-1"]')).toHaveCSS('background-color', 'rgb(15, 23, 42)')

  textPayload(await callTool(page, 'set_text_content', { id: 'title-1', text: 'From MCP' }))
  await expect(page.locator('[data-node-id="title-1"]')).toHaveText('From MCP')

  textPayload(await callTool(page, 'move_nodes', { moves: [{ id: 'card-1', x: 10, y: 300 }] }))
  await expect(page.locator('[data-node-id="card-1"]')).toHaveCSS('left', '10px')
})

test('dangerous CSS is rejected with a useful error', async ({ page }) => {
  const result = await callTool(page, 'update_styles', {
    updates: [{ id: 'hero-1', set: { background: 'url(javascript:alert(1))' } }],
  })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('rejected')
})

test('component tools: create, instance, override, variant', async ({ page }) => {
  const created = textPayload(
    await callTool(page, 'create_component', { nodeId: 'card-1', name: 'Card' }),
  ) as { componentId: string }
  expect(created.componentId).toBeTruthy()

  const inst = textPayload(
    await callTool(page, 'create_instance', { componentId: created.componentId, x: 560, y: 100 }),
  ) as { instanceId: string }
  await expect(page.locator(`[data-node-id="${inst.instanceId}"]`)).toBeVisible()

  textPayload(
    await callTool(page, 'set_instance_overrides', {
      instanceId: inst.instanceId,
      overrides: { 'title-1': { text: 'Override!', style: { color: 'rgb(220, 38, 38)' } } },
    }),
  )
  const overriddenTitle = page.locator(`[data-node-id="${inst.instanceId}:title-1"]`)
  await expect(overriddenTitle).toHaveText('Override!')
  await expect(overriddenTitle).toHaveCSS('color', 'rgb(220, 38, 38)')

  const variant = textPayload(
    await callTool(page, 'create_variant', { componentId: created.componentId, name: 'dark' }),
  ) as { variantId: string; rootId: string }
  expect(variant.variantId).toBeTruthy()
  // Variant roots nest inside the component-set frame, which lives on the
  // Design System page (Figma-style set).
  const variantHome = await page.evaluate((rootId) => {
    const cz = (window as never as {
      __canvazz: {
        editorStore: {
          doc: {
            pages: Array<{ id: string; children: string[] }>
            nodes: Record<string, { parent: string | null; isComponentSet?: boolean }>
          }
        }
      }
    }).__canvazz
    const doc = cz.editorStore.doc
    const setId = doc.nodes[rootId]?.parent ?? ''
    return {
      isSet: Boolean(doc.nodes[setId]?.isComponentSet),
      page: doc.pages.find((p) => p.children.includes(setId))?.id,
    }
  }, variant.rootId)
  expect(variantHome.isSet).toBe(true)
  expect(variantHome.page).toBe('page_design_system')

  // Switch the instance to the dark variant.
  textPayload(
    await callTool(page, 'set_instance_overrides', {
      instanceId: inst.instanceId,
      variantId: variant.variantId,
    }),
  )
  const instNode = await page.evaluate((id) => {
    const cz = (window as never as {
      __canvazz: { editorStore: { doc: { nodes: Record<string, { variantId?: string }> } } }
    }).__canvazz
    return cz.editorStore.doc.nodes[id]
  }, inst.instanceId)
  expect(instNode.variantId).toBe(variant.variantId)
})

test('get_screenshot returns a PNG with actual artboard pixels', async ({ page }) => {
  const result = await callTool(page, 'get_screenshot', {})
  const image = result.content.find((c) => c.type === 'image')
  expect(image).toBeTruthy()
  expect(image?.data?.length ?? 0).toBeGreaterThan(1000)
  // Regression: the clone once kept canvas placement (absolute left/top) and
  // rasterized fully transparent. Verify the capture is opaque content.
  const corner = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0)
    return [...ctx.getImageData(2, 2, 1, 1).data]
  }, image?.data ?? '')
  expect(corner[3]).toBe(255) // alpha: opaque, not a blank capture
})

test('finish clears AI indicators and reports the log', async ({ page }) => {
  textPayload(
    await callTool(page, 'write_html', {
      targetId: 'artboard-1',
      html: '<div data-cz-name="Tmp" style="position:absolute;left:0;top:0;width:10px;height:10px;background-color:red"></div>',
    }),
  )
  await expect(page.locator('.cz-ai-outline').first()).toBeVisible()
  const done = textPayload(await callTool(page, 'finish', { summary: 'test done' })) as {
    ok: boolean
    log: unknown[]
  }
  expect(done.ok).toBe(true)
  expect(done.log.length).toBeGreaterThan(0)
  // Pooled overlay elements stay in the DOM; they must just be hidden.
  await expect(page.locator('.cz-ai-outline:visible')).toHaveCount(0)
})

test('svg subset writes, renders, and round-trips', async ({ page }) => {
  const result = textPayload(
    await callTool(page, 'write_html', {
      targetId: 'artboard-1',
      html: `<svg data-cz-id="ring-1" data-cz-name="Ring" viewBox="0 0 92 92" width="92" height="92" style="position:absolute;left:20px;top:540px"><circle cx="46" cy="46" r="41.5" fill="none" stroke="#222226" stroke-width="9"></circle><circle cx="46" cy="46" r="41.5" fill="none" stroke="#0A9BFF" stroke-width="9" stroke-linecap="round" stroke-dasharray="65 196"></circle><use href="https://evil.example#x"></use></svg>`,
    }),
  ) as { ok: boolean; dropped: string[] }
  expect(result.ok).toBe(true)
  expect(result.dropped).toContain('tag:use')

  // Renders as a real SVG element with both circles.
  const isSvg = await page.evaluate(() => {
    const el = document.querySelector('[data-node-id="ring-1"]')
    return el instanceof SVGSVGElement && el.querySelectorAll('circle').length === 2
  })
  expect(isSvg).toBe(true)

  // Exports with case-preserved attributes.
  const html = (textPayload(await callTool(page, 'get_html', { id: 'ring-1' })) as { html: string }).html
  expect(html).toContain('viewBox="0 0 92 92"')
  expect(html).toContain('stroke-linecap="round"')
  expect(html).not.toContain('use')
})

test('pages: create_page and open_page via MCP', async ({ page }) => {
  const created = textPayload(await callTool(page, 'create_page', { name: 'protocols' })) as {
    pageId: string
  }
  expect(created.pageId).toBeTruthy()
  // New page is active and empty; artboard-1 not rendered.
  await expect(page.locator('[data-node-id="artboard-1"]')).toHaveCount(0)
  textPayload(await callTool(page, 'open_page', { page: 'Page 1' }))
  await expect(page.locator('[data-node-id="artboard-1"]')).toBeVisible()
  const info = textPayload(await callTool(page, 'get_basic_info', {})) as {
    pages: Array<{ name: string }>
  }
  expect(info.pages.map((p) => p.name)).toContain('protocols')
})

test('set_tokens defines tokens that recolor usages', async ({ page }) => {
  textPayload(await callTool(page, 'set_tokens', { set: { brand: '#ff0000' } }))
  textPayload(
    await callTool(page, 'update_styles', {
      updates: [{ id: 'hero-1', set: { background: null, 'background-color': 'var(--brand)' } }],
    }),
  )
  await expect(page.locator('[data-node-id="hero-1"]')).toHaveCSS('background-color', 'rgb(255, 0, 0)')
  textPayload(await callTool(page, 'set_tokens', { set: { brand: '#00ff00' } }))
  await expect(page.locator('[data-node-id="hero-1"]')).toHaveCSS('background-color', 'rgb(0, 255, 0)')
})

test('add_font loads a Google family usable in styles', async ({ page }) => {
  const result = textPayload(
    await callTool(page, 'add_font', { family: 'Space Grotesk', weights: [400, 700] }),
  ) as { ok: boolean; loaded: boolean }
  expect(result.ok).toBe(true)
  expect(result.loaded).toBe(true)
  const linked = await page.evaluate(
    () => document.querySelector('link[data-cz-font="Space Grotesk"]') !== null,
  )
  expect(linked).toBe(true)
  const fonts = textPayload(await callTool(page, 'get_fonts', {})) as {
    documentFonts: Record<string, unknown>
  }
  expect(Object.keys(fonts.documentFonts)).toContain('Space Grotesk')
})

test('insert_icon places SF Symbols as editable vectors', async ({ page }) => {
  const result = textPayload(
    await callTool(page, 'insert_icon', {
      name: 'heart.fill', targetId: 'artboard-1', x: 30, y: 560, size: 48, color: '#FF453A',
    }),
  ) as { ok: boolean; changedIds: string[]; symbol: string }
  expect(result.ok).toBe(true)
  expect(result.symbol).toBe('heart.fill')
  const id = result.changedIds[0]

  const info = await page.evaluate((nodeId) => {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`)
    return {
      isSvg: el instanceof SVGSVGElement,
      hasPath: !!el?.querySelector('path[d]'),
      color: el ? getComputedStyle(el).color : null,
    }
  }, id)
  expect(info.isSvg).toBe(true)
  expect(info.hasPath).toBe(true)
  expect(info.color).toBe('rgb(255, 69, 58)')

  // Unknown symbols error helpfully instead of inserting nothing.
  const bad = await callTool(page, 'insert_icon', { name: 'definitely.not.real' })
  expect(bad.isError).toBe(true)
  expect(bad.content[0].text).toContain('Unknown SF Symbol')
})

test('inspector swaps the SF Symbol on a selected icon', async ({ page }) => {
  textPayload(
    await callTool(page, 'insert_icon', { name: 'heart.fill', targetId: 'artboard-1', x: 40, y: 600, size: 40 }),
  )
  // The inserted icon is selected; the inspector shows its Icon section.
  const field = page.locator('[data-section="icon"] input').first()
  await expect(field).toHaveValue('heart.fill')
  await field.fill('star.fill')
  await field.press('Enter')
  // Selection follows the swap; the vector now reports star.fill.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const cz = (window as never as {
          __canvazz: {
            editorStore: { ui: { selection: string[] }; doc: { nodes: Record<string, { attrs: Record<string, string> }> } }
          }
        }).__canvazz
        const sel = cz.editorStore.ui.selection[0]
        return cz.editorStore.doc.nodes[sel]?.attrs['data-cz-icon']
      }),
    )
    .toBe('star.fill')
})

test('component stress: props, icon overrides, variants, delete', async ({ page }) => {
  test.setTimeout(90_000)
  // 1. Componentize the card: result carries componentId, rootId, AND the
  //    replacement instance id (no follow-up read needed).
  const created = textPayload(
    await callTool(page, 'create_component', { nodeId: 'card-1', name: 'Card' }),
  ) as { componentId: string; rootId: string; instanceId: string }
  expect(created.instanceId).toBeTruthy()
  expect(created.rootId).toBe('card-1')
  await expect(page.locator(`[data-node-id="${created.instanceId}"]`)).toBeVisible()

  // 2. Give the definition an icon slot; instances pick it up instantly.
  const icon = textPayload(
    await callTool(page, 'insert_icon', { name: 'heart.fill', targetId: 'card-1', size: 24 }),
  ) as { changedIds: string[] }
  const iconDefId = icon.changedIds[0]
  const defViewBox = await page.evaluate(
    (sel) => document.querySelector(sel)?.getAttribute('viewBox'),
    `[data-node-id="${created.instanceId}:${iconDefId}"]`,
  )
  expect(defViewBox).toBeTruthy()

  // 3. Icon prop: per-instance data-cz-icon override renders the new glyph.
  textPayload(
    await callTool(page, 'set_instance_overrides', {
      instanceId: created.instanceId,
      overrides: {
        [iconDefId]: { attrs: { 'data-cz-icon': 'star.fill' } },
        'title-1': { text: 'Stressed!' },
      },
    }),
  )
  await expect
    .poll(async () =>
      page.evaluate(
        (sel) => document.querySelector(sel)?.getAttribute('viewBox'),
        `[data-node-id="${created.instanceId}:${iconDefId}"]`,
      ),
    )
    .not.toBe(defViewBox)
  await expect(page.locator(`[data-node-id="${created.instanceId}:title-1"]`)).toHaveText('Stressed!')

  // 4. Variants ship an id map; overrides keyed by BASE ids survive switching.
  const variant = textPayload(
    await callTool(page, 'create_variant', { componentId: created.componentId, name: 'alt' }),
  ) as { variantId: string; idMap: Record<string, string> }
  expect(Object.keys(variant.idMap).length).toBeGreaterThan(3)
  expect(variant.idMap['title-1']).toBeTruthy()
  textPayload(
    await callTool(page, 'set_instance_overrides', {
      instanceId: created.instanceId,
      variantId: variant.variantId,
    }),
  )
  await expect(
    page.locator(`[data-node-id="${created.instanceId}:${variant.idMap['title-1']}"]`),
  ).toHaveText('Stressed!')

  // 5. set_visibility on a def node hides it in instances; an override re-shows
  //    it (keyed by the BASE id, applying to the variant clone via refId).
  textPayload(
    await callTool(page, 'set_visibility', {
      updates: [{ id: variant.idMap['body-1'], visible: false }],
    }),
  )
  await expect(page.locator(`[data-node-id="${created.instanceId}:${variant.idMap['body-1']}"]`)).toBeHidden()
  textPayload(
    await callTool(page, 'set_instance_overrides', {
      instanceId: created.instanceId,
      overrides: { 'body-1': { visible: true } },
    }),
  )
  await expect(page.locator(`[data-node-id="${created.instanceId}:${variant.idMap['body-1']}"]`)).toBeVisible()

  // 6. delete_component refuses while depended upon, then succeeds.
  const refused = await callTool(page, 'delete_component', { componentId: created.componentId })
  expect(refused.isError).toBe(true)
  const okDelete = textPayload(
    await callTool(page, 'delete_component', { componentId: variant.variantId }),
  ) as { ok: boolean }
  expect(okDelete.ok).toBe(true)
  // The instance fell back to the base definition and still renders overrides.
  await expect(page.locator(`[data-node-id="${created.instanceId}:title-1"]`)).toHaveText('Stressed!')

  // 7. Instances join the flow inside auto-layout containers.
  const flexBox = textPayload(
    await callTool(page, 'write_html', {
      targetId: 'artboard-1',
      html: '<div data-cz-name="Slot" style="position:absolute;left:10px;top:560px;display:flex;flex-direction:column;gap:8px;width:340px"></div>',
    }),
  ) as { changedIds: string[] }
  const flowInst = textPayload(
    await callTool(page, 'create_instance', { componentId: created.componentId, parentId: flexBox.changedIds[0] }),
  ) as { instanceId: string }
  const flowStyle = await page.evaluate((id) => {
    const cz = (window as never as {
      __canvazz: { editorStore: { doc: { nodes: Record<string, { style: Record<string, string> }> } } }
    }).__canvazz
    return cz.editorStore.doc.nodes[id]?.style
  }, flowInst.instanceId)
  expect(flowStyle.position).toBeUndefined()
  expect(flowStyle.left).toBeUndefined()
})
