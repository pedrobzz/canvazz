import { expect, test } from '@playwright/test'
import { centerOf, dragBy, openEditor } from './helpers'
import type { Page } from '@playwright/test'

/**
 * Comment threads end to end: the canvas gesture (click a node / drag an area)
 * → composer → pin, the live thread state, and the MCP agent joining the thread
 * over the SSE bridge (list_comments / get_comment / reply_comment).
 */

let rpcId = 500

async function callTool(page: Page, name: string, args: Record<string, unknown>) {
  const project = await page.evaluate(
    () => (window as never as { __canvazz: { projectId: string } }).__canvazz.projectId,
  )
  const response = await page.request.post('/mcp', {
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: { project, ...args } } },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    result: { content: Array<{ type: string; text?: string }>; isError?: boolean }
  }
  const text = body.result.content.find((c) => c.type === 'text')?.text ?? ''
  return { isError: body.result.isError, payload: text.startsWith('Error') ? text : JSON.parse(text) }
}

/** All comment threads in the live document. */
function threads(page: Page) {
  return page.evaluate(() => {
    const cz = (window as never as {
      __canvazz: { editorStore: { doc: { comments?: unknown[] } } }
    }).__canvazz
    return cz.editorStore.doc.comments ?? []
  }) as Promise<Array<{
    id: string; resolved: boolean; nodeIds: string[]; area?: unknown
    messages: Array<{ author: string; body: string }>
  }>>
}

test.beforeEach(async ({ page }) => {
  await openEditor(page)
})

test('comment tool pins a node comment with the typed message', async ({ page }) => {
  await page.locator('[data-tool="comment"]').click()
  const c = await centerOf(page, 'artboard-1')
  await page.mouse.click(c.x, c.y)

  // Composer opens; type and submit with Enter.
  const composer = page.locator('.cz-comment-layer textarea')
  await expect(composer).toBeVisible()
  await composer.fill('Make the title bigger')
  await composer.press('Enter')

  // A pin renders and the thread is in the document.
  await expect(page.locator('.cz-comment-pin')).toHaveCount(1)
  const all = await threads(page)
  expect(all).toHaveLength(1)
  expect(all[0].messages[0]).toMatchObject({ author: 'user', body: 'Make the title bigger' })
  expect(all[0].nodeIds.length).toBeGreaterThan(0)
})

test('dragging the comment tool makes an area comment over the covered nodes', async ({ page }) => {
  await page.locator('[data-tool="comment"]').click()
  const c = await centerOf(page, 'artboard-1')
  await dragBy(page, { x: c.x - 60, y: c.y - 60 }, 120, 120)

  const composer = page.locator('.cz-comment-layer textarea')
  await expect(composer).toBeVisible()
  await composer.fill('Tighten this whole block')
  await composer.press('Enter')

  const all = await threads(page)
  expect(all).toHaveLength(1)
  expect(all[0].area).toBeTruthy()
  expect(all[0].nodeIds.length).toBeGreaterThan(0)

  // The Comments panel lists it under Open.
  await page.getByRole('tab', { name: 'Notes' }).click()
  await expect(page.locator('[data-testid="comments-panel"]')).toContainText('Open')
  await expect(page.locator('[data-testid="comments-panel"]')).toContainText('Tighten this whole block')
})

test('MCP agent reads and replies to a thread, auto-resolving it', async ({ page }) => {
  await expect(page.getByText('MCP live')).toBeVisible({ timeout: 10_000 })

  // Seed a user comment through the store (the gesture is covered above).
  const threadId = await page.evaluate(() => {
    const cz = (window as never as {
      __canvazz: { editorStore: { addCommentThread(i: object): { id: string } } }
    }).__canvazz
    return cz.editorStore.addCommentThread({
      x: 60, y: 80, nodeIds: ['artboard-1'], body: 'Can you make the header bigger?',
    }).id
  })

  // list_comments returns the open thread with its attached node.
  const list = await callTool(page, 'list_comments', {})
  expect(list.isError).toBeFalsy()
  expect(list.payload.count).toBe(1)
  expect(list.payload.comments[0]).toMatchObject({ id: threadId, resolved: false })
  expect(list.payload.comments[0].attachedNodeIds).toContain('artboard-1')

  // get_comment carries the full thread + an attached-node tree.
  const detail = await callTool(page, 'get_comment', { commentId: threadId })
  expect(detail.payload.messages).toHaveLength(1)
  expect(String(detail.payload.attachedTree)).toContain('artboard-1')

  // reply_comment auto-resolves; the pin flips to resolved and the agent
  // message lands in the thread.
  const reply = await callTool(page, 'reply_comment', { commentId: threadId, body: 'Done — header is now 28px.' })
  expect(reply.payload.resolved).toBe(true)
  await expect(page.locator('.cz-comment-pin--resolved')).toHaveCount(1)

  const all = await threads(page)
  expect(all[0].resolved).toBe(true)
  expect(all[0].messages.at(-1)).toMatchObject({ author: 'agent', body: 'Done — header is now 28px.' })

  // Open threads are now empty by default.
  const afterList = await callTool(page, 'list_comments', {})
  expect(afterList.payload.count).toBe(0)
})
