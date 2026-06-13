import { describe, expect, it } from 'vitest'
import { sfSymbolMarkup } from '@/components/SFSymbol'
import { parseHtml } from '#/editor/compiler/parse'
import { applyOps, emptyDocument } from '#/editor/model/doc'
import { createFrame } from '#/editor/model/factory'
import type { DocumentModel, NodeModel, Op } from '#/editor/model/types'

/**
 * Mirrors what the insert_icon batch executor builds: one insertTree op per
 * glyph, combined into a single transaction. Verifies the contract the
 * executor relies on — distinct ids, every root inserted, one undoable step —
 * without importing the live canvas store.
 */
function collectFrom(nodes: NodeModel[], rootId: string): NodeModel[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: NodeModel[] = []
  const walk = (id: string) => {
    const n = byId.get(id)
    if (!n) return
    out.push(n)
    n.children.forEach(walk)
  }
  walk(rootId)
  return out
}

describe('insert_icon batch transaction', () => {
  it('places several glyphs in one transaction with distinct ids', async () => {
    let doc: DocumentModel = emptyDocument('d', 'T')
    const frame = createFrame('Frame', { x: 0, y: 0, width: 400, height: 300 })
    doc = applyOps(doc, [
      { t: 'insertTree', nodes: [frame], rootId: frame.id, at: { kind: 'page', pageId: 'page_1', index: 0 } },
    ]).doc

    const names = ['house.fill', 'heart.fill', 'star.fill']
    const ops: Op[] = []
    const createdIds: string[] = []
    const pending = new Set<string>()
    for (const [i, name] of names.entries()) {
      const markup = await sfSymbolMarkup(name, { variant: 'monochrome', size: 24 })
      expect(markup).toBeTruthy()
      const { nodes, rootIds } = parseHtml(markup ?? '', {
        isIdTaken: (id) => Boolean(doc.nodes[id]) || pending.has(id),
      })
      const rootId = rootIds[0]
      expect(rootId).toBeTruthy()
      const tree = collectFrom(nodes, rootId)
      for (const n of tree) pending.add(n.id)
      ops.push({ t: 'insertTree', nodes: tree, rootId, at: { kind: 'node', parent: frame.id, index: i } })
      createdIds.push(rootId)
    }

    // distinct roots
    expect(new Set(createdIds).size).toBe(3)

    const before = doc
    doc = applyOps(doc, ops).doc
    // one application added all three glyph roots under the frame
    expect(doc.nodes[frame.id].children).toEqual(createdIds)
    for (const id of createdIds) {
      expect(doc.nodes[id]).toBeTruthy()
      expect(doc.nodes[id].tag).toBe('svg')
    }
    // no id from the batch existed before it was applied
    expect(createdIds.every((id) => !before.nodes[id])).toBe(true)
  }, 20_000)
})
