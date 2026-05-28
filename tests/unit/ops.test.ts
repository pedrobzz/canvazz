import { describe, expect, it } from 'vitest'
import { applyOps, emptyDocument } from '#/editor/model/doc'
import { createFrame, createRectangle, createText } from '#/editor/model/factory'
import type { DocumentModel, Op } from '#/editor/model/types'

function docWithFrame(): { doc: DocumentModel; frameId: string; rectId: string; textId: string } {
  let doc = emptyDocument('d1', 'Test')
  const frame = createFrame('Frame', { x: 0, y: 0, width: 400, height: 300 })
  const rect = createRectangle({ x: 10, y: 10, width: 50, height: 50 })
  const text = createText(20, 80, 'Hello')
  const ops: Op[] = [
    { t: 'insertTree', nodes: [frame], rootId: frame.id, at: { kind: 'page', pageId: 'page_1', index: 0 } },
    { t: 'insertTree', nodes: [rect], rootId: rect.id, at: { kind: 'node', parent: frame.id, index: 0 } },
    { t: 'insertTree', nodes: [text], rootId: text.id, at: { kind: 'node', parent: frame.id, index: 1 } },
  ]
  doc = applyOps(doc, ops).doc
  return { doc, frameId: frame.id, rectId: rect.id, textId: text.id }
}

describe('applyOps', () => {
  it('insert + remove round-trips through inverses', () => {
    const { doc, frameId } = docWithFrame()
    const { doc: removed, inverse } = applyOps(doc, [{ t: 'remove', id: frameId }])
    expect(Object.keys(removed.nodes)).toHaveLength(0)
    expect(removed.pages[0].children).toHaveLength(0)

    const { doc: restored } = applyOps(removed, inverse)
    expect(restored.nodes).toEqual(doc.nodes)
    expect(restored.pages).toEqual(doc.pages)
  })

  it('move reparents and inverts to original location', () => {
    const { doc, frameId, rectId, textId } = docWithFrame()
    const { doc: moved, inverse } = applyOps(doc, [
      { t: 'move', id: rectId, to: { kind: 'page', pageId: 'page_1', index: 1 } },
    ])
    expect(moved.nodes[rectId].parent).toBeNull()
    expect(moved.pages[0].children).toEqual([frameId, rectId])
    expect(moved.nodes[frameId].children).toEqual([textId])

    const { doc: back } = applyOps(moved, inverse)
    expect(back.nodes[frameId].children).toEqual([rectId, textId])
    expect(back.nodes[rectId].parent).toBe(frameId)
  })

  it('rejects moving a node into its own subtree', () => {
    const { doc, frameId, rectId } = docWithFrame()
    expect(() => applyOps(doc, [{ t: 'move', id: frameId, to: { kind: 'node', parent: rectId, index: 0 } }])).toThrow(
      /own subtree/,
    )
  })

  it('setStyle records previous values for undo, including absent keys', () => {
    const { doc, rectId } = docWithFrame()
    const { doc: styled, inverse } = applyOps(doc, [
      { t: 'setStyle', id: rectId, set: { 'background-color': '#ff0000', opacity: '0.5' } },
    ])
    expect(styled.nodes[rectId].style['background-color']).toBe('#ff0000')
    const { doc: back } = applyOps(styled, inverse)
    expect(back.nodes[rectId].style['background-color']).toBe('#d9d9d9')
    expect(back.nodes[rectId].style.opacity).toBeUndefined()
  })

  it('preserves referential identity of untouched nodes', () => {
    const { doc, rectId, textId } = docWithFrame()
    const { doc: next } = applyOps(doc, [{ t: 'setProps', id: rectId, patch: { name: 'Box' } }])
    expect(next.nodes[textId]).toBe(doc.nodes[textId])
    expect(next.nodes[rectId]).not.toBe(doc.nodes[rectId])
  })

  it('applies multi-op transactions atomically with reversed inverse', () => {
    const { doc, rectId, textId } = docWithFrame()
    const { doc: next, inverse, changed } = applyOps(doc, [
      { t: 'setProps', id: rectId, patch: { name: 'A' } },
      { t: 'setProps', id: textId, patch: { name: 'B' } },
      { t: 'remove', id: rectId },
    ])
    expect(next.nodes[rectId]).toBeUndefined()
    expect(changed).toContain(rectId)
    expect(changed).toContain(textId)
    const { doc: back } = applyOps(next, inverse)
    expect(back.nodes[rectId].name).toBe('Rectangle')
    expect(back.nodes[textId].name).toBe(createText(0, 0, 'Hello').name)
  })
})
