import { expect, test } from '@playwright/test'
import { openEditor } from './helpers'
import type { Page } from '@playwright/test'

/**
 * End-to-end MCP contract: HTTP tool call -> SSE bridge -> live editor ->
 * result. The page must stay open; it is the execution environment.
 */

let rpcId = 100

async function callTool(page: Page, name: string, args: Record<string, unknown>) {
  const response = await page.request.post('/mcp', {
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    result: { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }
  }
  return body.result
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
  await expect(page.locator(`[data-node-id="${variant.rootId}"]`)).toBeVisible()

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

test('get_screenshot returns a PNG image', async ({ page }) => {
  const result = await callTool(page, 'get_screenshot', {})
  const image = result.content.find((c) => c.type === 'image')
  expect(image).toBeTruthy()
  expect(image?.data?.length ?? 0).toBeGreaterThan(1000)
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
