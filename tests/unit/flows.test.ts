import { describe, expect, it } from 'vitest'
import { applyOps, emptyDocument } from '#/editor/model/doc'
import { migrateDocument } from '#/editor/model/migrate'
import { EditorStore } from '#/editor/store/editorStore'
import { createArtboard } from '#/editor/model/factory'
import type { DocumentModel, FlowLink, Op } from '#/editor/model/types'

/** Two artboards on the page, ready to be linked. */
function twoBoards(): { doc: DocumentModel; a: string; b: string } {
  let doc = emptyDocument('d', 'T')
  const a = createArtboard('Home', { x: 0, y: 0, width: 375, height: 667 })
  const b = createArtboard('Detail', { x: 450, y: 0, width: 375, height: 667 })
  doc = applyOps(doc, [
    { t: 'insertTree', nodes: [a], rootId: a.id, at: { kind: 'page', pageId: 'page_1', index: 0 } },
    { t: 'insertTree', nodes: [b], rootId: b.id, at: { kind: 'page', pageId: 'page_1', index: 1 } },
  ]).doc
  return { doc, a: a.id, b: b.id }
}

const link = (id: string, fromId: string, toId: string): FlowLink => ({ id, fromId, toId, trigger: 'tap' })

describe('flow ops (setFlow / removeFlow)', () => {
  it('setFlow adds a link and inverts to removeFlow', () => {
    const { doc, a, b } = twoBoards()
    const { doc: withFlow, inverse } = applyOps(doc, [{ t: 'setFlow', flow: link('f1', a, b) }])
    expect(withFlow.flows).toHaveLength(1)
    expect(withFlow.flows?.[0]).toMatchObject({ id: 'f1', fromId: a, toId: b, trigger: 'tap' })

    const { doc: undone } = applyOps(withFlow, inverse)
    expect(undone.flows).toHaveLength(0)
  })

  it('setFlow on an existing id updates and inverts to the prior value', () => {
    const { doc, a, b } = twoBoards()
    const d1 = applyOps(doc, [{ t: 'setFlow', flow: link('f1', a, b) }]).doc
    const { doc: d2, inverse } = applyOps(d1, [
      { t: 'setFlow', flow: { id: 'f1', fromId: a, toId: b, trigger: 'hover', label: 'open detail' } },
    ])
    expect(d2.flows?.[0]).toMatchObject({ trigger: 'hover', label: 'open detail' })
    const { doc: back } = applyOps(d2, inverse)
    expect(back.flows?.[0]).toMatchObject({ trigger: 'tap' })
    expect(back.flows?.[0].label).toBeUndefined()
  })

  it('removeFlow deletes and inverts back to the link', () => {
    const { doc, a, b } = twoBoards()
    const d1 = applyOps(doc, [{ t: 'setFlow', flow: link('f1', a, b) }]).doc
    const { doc: d2, inverse } = applyOps(d1, [{ t: 'removeFlow', id: 'f1' }])
    expect(d2.flows).toHaveLength(0)
    const { doc: back } = applyOps(d2, inverse)
    expect(back.flows).toHaveLength(1)
  })

  it('removeFlow throws on an unknown id', () => {
    const { doc } = twoBoards()
    expect(() => applyOps(doc, [{ t: 'removeFlow', id: 'nope' }])).toThrow(/Unknown flow/)
  })
})

describe('flow cleanup on node removal', () => {
  it('deleting either endpoint removes the link, and undo restores both', () => {
    const { doc, a, b } = twoBoards()
    const linked = applyOps(doc, [
      { t: 'setFlow', flow: link('f1', a, b) },
      { t: 'setFlow', flow: { id: 'f2', fromId: b, toId: a, trigger: 'tap' } },
    ]).doc
    expect(linked.flows).toHaveLength(2)

    // Removing artboard A should drop both links (each references A).
    const { doc: afterRemove, inverse } = applyOps(linked, [{ t: 'remove', id: a }])
    expect(afterRemove.flows).toHaveLength(0)
    expect(afterRemove.nodes[a]).toBeUndefined()

    // Undo restores the node and its dangling links in one shot.
    const { doc: restored } = applyOps(afterRemove, inverse)
    expect(restored.nodes[a]).toBeDefined()
    expect(restored.flows).toHaveLength(2)
  })

  it('unrelated links survive a removal', () => {
    const { doc, a, b } = twoBoards()
    const c = createArtboard('Settings', { x: 900, y: 0, width: 375, height: 667 })
    const d1 = applyOps(doc, [
      { t: 'insertTree', nodes: [c], rootId: c.id, at: { kind: 'page', pageId: 'page_1', index: 2 } },
      { t: 'setFlow', flow: link('f1', a, b) },
      { t: 'setFlow', flow: link('f2', b, c.id) },
    ]).doc
    const { doc: afterRemove } = applyOps(d1, [{ t: 'remove', id: a }])
    // f1 (touches A) gone; f2 (b→c) untouched.
    expect(afterRemove.flows?.map((f) => f.id)).toEqual(['f2'])
  })
})

describe('flows migration / defaults', () => {
  it('emptyDocument starts with an empty flows array', () => {
    expect(emptyDocument('d', 'T').flows).toEqual([])
  })

  it('migrateDocument backfills a missing flows array', () => {
    const doc = emptyDocument('d', 'T')
    delete (doc as { flows?: unknown }).flows
    expect(migrateDocument(doc).flows).toEqual([])
  })
})

describe('flow links through the store (undo + persistence shape)', () => {
  it('links survive a save/reload round trip (replaceDocument)', () => {
    const { doc, a, b } = twoBoards()
    const store = new EditorStore()
    store.replaceDocument(doc)
    store.apply('link', [{ t: 'setFlow', flow: link('f1', a, b) }] as Op[], 'user')
    expect(store.doc.flows).toHaveLength(1)

    // Simulate reload: serialize-ish then re-open.
    const reopened = new EditorStore()
    reopened.replaceDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.doc.flows).toEqual([{ id: 'f1', fromId: a, toId: b, trigger: 'tap' }])
  })

  it('a link is a single undoable transaction', () => {
    const { doc, a, b } = twoBoards()
    const store = new EditorStore()
    store.replaceDocument(doc)
    store.apply('link', [{ t: 'setFlow', flow: link('f1', a, b) }] as Op[], 'user')
    expect(store.doc.flows).toHaveLength(1)
    store.undo()
    expect(store.doc.flows).toHaveLength(0)
  })
})
