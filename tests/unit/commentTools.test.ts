import { beforeEach, describe, expect, it } from 'vitest'
import { aiToolExecutors } from '#/editor/ai/aiTools'
import { editorStore } from '#/editor/store/editorStore'
import { emptyDocument } from '#/editor/model/doc'
import { createArtboard } from '#/editor/model/factory'
import type { CommentThread } from '#/editor/model/types'

/** Executors run against the shared editorStore singleton. */
function call(tool: string, args: Record<string, unknown> = {}) {
  return aiToolExecutors[tool](args) as Record<string, unknown>
}

/** A doc with one artboard "Home", loaded into the singleton store. */
function loadBoard(): string {
  const doc = emptyDocument('d', 'T')
  const board = createArtboard('Home', { x: 0, y: 0, width: 375, height: 667 })
  doc.nodes[board.id] = board
  doc.pages[0].children = [board.id]
  editorStore.replaceDocument(doc)
  return board.id
}

describe('list_comments', () => {
  let boardId: string
  beforeEach(() => {
    boardId = loadBoard()
  })

  it('returns unresolved threads only by default, with attached nodes and last message', () => {
    editorStore.addCommentThread({ x: 20, y: 30, nodeIds: [boardId], body: 'Tighten the spacing' })
    const resolved = editorStore.addCommentThread({ x: 0, y: 0, body: 'old' })
    editorStore.setCommentResolved(resolved.id, true)

    const res = call('list_comments')
    expect(res.count).toBe(1)
    const comments = res.comments as Array<Record<string, unknown>>
    expect(comments[0]).toMatchObject({ resolved: false, kind: 'node', attachedNodeIds: [boardId] })
    expect((comments[0].attachedNodes as unknown[]).length).toBe(1)
    expect(comments[0].lastMessage).toMatchObject({ author: 'user', body: 'Tighten the spacing' })
  })

  it('includeResolved returns the resolved ones too', () => {
    const t = editorStore.addCommentThread({ x: 0, y: 0, body: 'x' })
    editorStore.setCommentResolved(t.id, true)
    expect((call('list_comments').comments as unknown[]).length).toBe(0)
    expect((call('list_comments', { includeResolved: true }).comments as unknown[]).length).toBe(1)
  })

  it('marks area comments with kind:"area" and a rounded rect', () => {
    editorStore.addCommentThread({ x: 5, y: 5, area: { x: 5, y: 5, width: 100.4, height: 80.6 }, body: 'block' })
    const c = (call('list_comments').comments as Array<Record<string, unknown>>)[0]
    expect(c.kind).toBe('area')
    expect(c.area).toEqual({ x: 5, y: 5, width: 100, height: 81 })
  })

  it('filters by page', () => {
    editorStore.addCommentThread({ x: 0, y: 0, body: 'on page 1' })
    expect((call('list_comments', { page: 'Page 1' }).comments as unknown[]).length).toBe(1)
    expect(() => call('list_comments', { page: 'Nope' })).toThrow(/Unknown page/)
  })
})

describe('get_comment', () => {
  beforeEach(loadBoard)

  it('returns the full message history and an attached-node tree', () => {
    const boardId = editorStore.activePage().children[0]
    const thread = editorStore.addCommentThread({ x: 0, y: 0, nodeIds: [boardId], body: 'first' })
    editorStore.addCommentMessage(thread.id, 'second', 'user')

    const res = call('get_comment', { commentId: thread.id })
    expect((res.messages as unknown[]).length).toBe(2)
    expect(res.attachedTree).toContain('Home')
  })

  it('throws a helpful error for an unknown id', () => {
    expect(() => call('get_comment', { commentId: 'nope' })).toThrow(/Unknown comment id/)
    expect(() => call('get_comment')).toThrow(/Provide commentId/)
  })
})

describe('reply_comment', () => {
  let thread: CommentThread
  beforeEach(() => {
    loadBoard()
    thread = editorStore.addCommentThread({ x: 0, y: 0, body: 'Can you make the header bigger?' })
  })

  it('appends an agent reply and auto-resolves by default', () => {
    const res = call('reply_comment', { commentId: thread.id, body: 'Done — header is now 28px.' })
    expect(res.resolved).toBe(true)
    const updated = editorStore.getCommentThread(thread.id)!
    expect(updated.resolved).toBe(true)
    const last = updated.messages[updated.messages.length - 1]
    expect(last).toMatchObject({ author: 'agent', body: 'Done — header is now 28px.' })
  })

  it('resolve:false replies without resolving (and reopens a resolved thread)', () => {
    editorStore.setCommentResolved(thread.id, true)
    const res = call('reply_comment', {
      commentId: thread.id, body: 'Which header — the page title or the card?', resolve: false,
    })
    expect(res.resolved).toBe(false)
    expect(editorStore.getCommentThread(thread.id)?.resolved).toBe(false)
  })

  it('requires a non-empty body and a known thread', () => {
    expect(() => call('reply_comment', { commentId: thread.id, body: '  ' })).toThrow(/body is required/)
    expect(() => call('reply_comment', { commentId: 'nope', body: 'hi' })).toThrow(/Unknown comment id/)
  })
})
