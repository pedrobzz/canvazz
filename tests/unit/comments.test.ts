import { describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { migrateDocument } from '#/editor/model/migrate'
import { EditorStore } from '#/editor/store/editorStore'
import { createArtboard } from '#/editor/model/factory'

/** A store opened on a doc with one artboard, ready to receive comments. */
function storeWithBoard() {
  let doc = emptyDocument('d', 'T')
  const board = createArtboard('Home', { x: 0, y: 0, width: 375, height: 667 })
  doc = { ...doc, nodes: { [board.id]: board }, pages: [{ ...doc.pages[0], children: [board.id] }] }
  const store = new EditorStore()
  store.replaceDocument(doc)
  return { store, boardId: board.id }
}

describe('comments — document defaults & migration', () => {
  it('emptyDocument starts with an empty comments array', () => {
    expect(emptyDocument('d', 'T').comments).toEqual([])
  })

  it('migrateDocument backfills a missing comments array', () => {
    const doc = emptyDocument('d', 'T')
    delete (doc as { comments?: unknown }).comments
    expect(migrateDocument(doc).comments).toEqual([])
  })

  it('migrateDocument repairs legacy flat-pin comments (no messages array)', () => {
    const doc = emptyDocument('d', 'T')
    // Shape persisted by the first (removed) comment experiment — no messages.
    ;(doc as { comments: unknown[] }).comments = [
      { id: 'c_old', nodeId: 'n1', x: 10, y: 20, author: 'You', body: 'old note', createdAt: 111, resolved: true },
    ]
    const repaired = migrateDocument(doc).comments!
    expect(repaired).toHaveLength(1)
    expect(repaired[0]).toMatchObject({
      id: 'c_old', x: 10, y: 20, nodeIds: ['n1'], resolved: true, pageId: 'page_1',
    })
    expect(repaired[0].messages).toHaveLength(1)
    expect(repaired[0].messages[0]).toMatchObject({ author: 'user', body: 'old note', createdAt: 111 })
  })

  it('migrateDocument drops junk comment entries and keeps valid threads', () => {
    const doc = emptyDocument('d', 'T')
    ;(doc as { comments: unknown[] }).comments = [
      null,
      'nope',
      { id: 'c_ok', pageId: 'page_1', x: 0, y: 0, nodeIds: [], resolved: false, createdAt: 1,
        messages: [{ id: 'm1', author: 'user', body: 'hi', createdAt: 1 }] },
    ]
    const repaired = migrateDocument(doc).comments!
    expect(repaired).toHaveLength(1)
    expect(repaired[0].id).toBe('c_ok')
  })
})

describe('comments — thread lifecycle through the store', () => {
  it('addCommentThread pins a node comment with one opening message', () => {
    const { store, boardId } = storeWithBoard()
    const thread = store.addCommentThread({ x: 40, y: 60, nodeIds: [boardId], body: 'Make this bolder' })
    expect(store.doc.comments).toHaveLength(1)
    expect(thread).toMatchObject({ x: 40, y: 60, nodeIds: [boardId], resolved: false, pageId: 'page_1' })
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]).toMatchObject({ author: 'user', body: 'Make this bolder' })
    expect(thread.area).toBeUndefined()
  })

  it('addCommentThread records an area rect for area comments', () => {
    const { store } = storeWithBoard()
    const area = { x: 10, y: 10, width: 100, height: 80 }
    const thread = store.addCommentThread({ x: 10, y: 10, area, body: 'This whole block' })
    expect(thread.area).toEqual(area)
  })

  it('addCommentMessage appends a reply and reopens a resolved thread by default', () => {
    const { store } = storeWithBoard()
    const thread = store.addCommentThread({ x: 0, y: 0, body: 'Q?' })
    store.setCommentResolved(thread.id, true)
    expect(store.getCommentThread(thread.id)?.resolved).toBe(true)

    const reply = store.addCommentMessage(thread.id, 'A!', 'agent')
    expect(reply?.author).toBe('agent')
    const updated = store.getCommentThread(thread.id)!
    expect(updated.messages.map((m) => m.body)).toEqual(['Q?', 'A!'])
    expect(updated.resolved).toBe(false) // reply reopened it
  })

  it('addCommentMessage with reopen:false keeps a resolved thread resolved', () => {
    const { store } = storeWithBoard()
    const thread = store.addCommentThread({ x: 0, y: 0, body: 'Done?' })
    store.setCommentResolved(thread.id, true)
    store.addCommentMessage(thread.id, 'Yes — shipped.', 'agent', { reopen: false })
    expect(store.getCommentThread(thread.id)?.resolved).toBe(true)
  })

  it('editCommentMessage rewrites a message body and stamps editedAt', () => {
    const { store } = storeWithBoard()
    const thread = store.addCommentThread({ x: 0, y: 0, body: 'typo heer' })
    const messageId = thread.messages[0].id
    expect(store.editCommentMessage(thread.id, messageId, 'typo here')).toBe(true)
    const edited = store.getCommentThread(thread.id)!.messages[0]
    expect(edited.body).toBe('typo here')
    expect(edited.editedAt).toBeTypeOf('number')
  })

  it('setCommentResolved is a no-op when already in the requested state', () => {
    const { store } = storeWithBoard()
    const thread = store.addCommentThread({ x: 0, y: 0, body: 'x' })
    expect(store.setCommentResolved(thread.id, false)).toBe(false)
    expect(store.setCommentResolved(thread.id, true)).toBe(true)
  })

  it('deleteCommentThread removes the thread and clears the open card', () => {
    const { store } = storeWithBoard()
    const thread = store.addCommentThread({ x: 0, y: 0, body: 'x' })
    store.setUi({ activeCommentId: thread.id })
    expect(store.deleteCommentThread(thread.id)).toBe(true)
    expect(store.doc.comments).toHaveLength(0)
    expect(store.ui.activeCommentId).toBeNull()
  })

  it('mutations on an unknown thread id are inert', () => {
    const { store } = storeWithBoard()
    expect(store.addCommentMessage('nope', 'hi')).toBeNull()
    expect(store.editCommentMessage('nope', 'msg', 'hi')).toBe(false)
    expect(store.setCommentResolved('nope', true)).toBe(false)
    expect(store.deleteCommentThread('nope')).toBe(false)
  })
})

describe('comments — persistence & undo isolation', () => {
  it('threads survive a save/reload round trip (replaceDocument)', () => {
    const { store, boardId } = storeWithBoard()
    store.addCommentThread({ x: 5, y: 5, nodeIds: [boardId], body: 'keep me' })

    const reopened = new EditorStore()
    reopened.replaceDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.doc.comments).toHaveLength(1)
    expect(reopened.doc.comments?.[0].messages[0].body).toBe('keep me')
  })

  it('comment mutations are not undoable and survive design undo/redo', () => {
    const { store, boardId } = storeWithBoard()
    store.addCommentThread({ x: 0, y: 0, nodeIds: [boardId], body: 'note' })
    // A comment is not a transaction — there is nothing on the undo stack.
    expect(store.canUndo()).toBe(false)

    // A real design edit, then undo: comments must be untouched either way.
    store.apply('rename', [{ t: 'setProps', id: boardId, patch: { name: 'Renamed' } }])
    expect(store.canUndo()).toBe(true)
    store.undo()
    expect(store.doc.comments).toHaveLength(1)
    store.redo()
    expect(store.doc.comments).toHaveLength(1)
  })
})
