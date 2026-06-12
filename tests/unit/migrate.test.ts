import { describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { migrateDocument } from '#/editor/model/migrate'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

function node(partial: Partial<NodeModel> & Pick<NodeModel, 'id' | 'tag'>): NodeModel {
  return {
    name: partial.id, attrs: {}, style: {}, classes: [], children: [],
    parent: null, visible: true, locked: false, ...partial,
  } as NodeModel
}

/** A v1 document: variant roots are flat page nodes; the set is metadata-only. */
function v1Doc(): DocumentModel {
  const doc = emptyDocument('d', 'T')
  doc.schemaVersion = 1
  doc.nodes = {
    root: node({ id: 'root', tag: 'div', isComponentRoot: true, style: { position: 'absolute', left: '100px', top: '60px', width: '320px' } }),
    vroot: node({ id: 'vroot', tag: 'div', isComponentRoot: true, refId: 'root', style: { position: 'absolute', left: '460px', top: '60px', width: '320px' } }),
  }
  doc.components = {
    cmp: { id: 'cmp', name: 'Card', rootId: 'root', setId: 'set', variantProps: { variant: 'default' } },
    cmpv: { id: 'cmpv', name: 'Card / alt', rootId: 'vroot', setId: 'set', variantProps: { variant: 'alt' } },
  }
  // Old shape: no nodeId on the set.
  doc.componentSets = { set: { id: 'set', name: 'Card', variantIds: ['cmp', 'cmpv'], defaultVariantId: 'cmp' } as never }
  doc.pages[0].children = ['root', 'vroot']
  return doc
}

describe('migrateDocument v1 → v2 (set frames)', () => {
  it('wraps a flat set into a real set node with the variant roots as children', () => {
    const out = migrateDocument(v1Doc())
    expect(out.schemaVersion).toBe(2)

    const setNodeId = out.componentSets.set.nodeId
    expect(setNodeId).toBeTruthy()
    const setNode = out.nodes[setNodeId]
    expect(setNode.isComponentSet).toBe(true)
    expect(setNode.children).toEqual(['root', 'vroot'])
    expect(setNode.style.border).toContain('dashed')

    // Variant roots are re-homed and shed their page-level placement.
    for (const id of ['root', 'vroot']) {
      expect(out.nodes[id].parent).toBe(setNodeId)
      expect(out.nodes[id].style.position).toBeUndefined()
      expect(out.nodes[id].style.left).toBeUndefined()
      // Intrinsic size is preserved.
      expect(out.nodes[id].style.width).toBe('320px')
    }

    // The page now holds the set node, not the loose roots.
    expect(out.pages[0].children).toEqual([setNodeId])
  })

  it('is idempotent (a v2 doc passes through unchanged)', () => {
    const once = migrateDocument(v1Doc())
    const twice = migrateDocument(once)
    expect(twice).toEqual(once)
  })
})
