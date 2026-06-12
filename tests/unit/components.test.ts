import { describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { canonicalSourceId, overrideFor, resolveNode } from '#/editor/model/instances'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

function node(partial: Partial<NodeModel> & Pick<NodeModel, 'id' | 'tag'>): NodeModel {
  return {
    name: partial.id, attrs: {}, style: {}, classes: [], children: [],
    parent: null, visible: true, locked: false, ...partial,
  } as NodeModel
}

/** Component with one text slot, a variant clone (refId-stamped), an instance. */
function fixture(): DocumentModel {
  const doc = emptyDocument('d', 'T')
  doc.nodes = {
    cset: node({ id: 'cset', tag: 'div', isComponentSet: true, children: ['root', 'vroot'] }),
    root: node({ id: 'root', tag: 'div', isComponentRoot: true, parent: 'cset', children: ['title'] }),
    title: node({ id: 'title', tag: 'span', parent: 'root', text: 'Base title' }),
    vroot: node({ id: 'vroot', tag: 'div', isComponentRoot: true, parent: 'cset', children: ['vtitle'], refId: 'root' }),
    vtitle: node({ id: 'vtitle', tag: 'span', parent: 'vroot', text: 'Variant title', refId: 'title' }),
    inst: node({
      id: 'inst', tag: 'div', componentId: 'cmp',
      overrides: { title: { text: 'Overridden!' } },
    }),
  }
  doc.components = {
    cmp: { id: 'cmp', name: 'C', rootId: 'root', setId: 'set' },
    cmpv: { id: 'cmpv', name: 'C / alt', rootId: 'vroot', setId: 'set' },
  }
  doc.componentSets = { set: { id: 'set', name: 'C', nodeId: 'cset', variantIds: ['cmp', 'cmpv'], defaultVariantId: 'cmp' } }
  doc.pages[0].children = ['cset', 'inst']
  return doc
}

describe('component overrides across variants (refId)', () => {
  it('canonicalSourceId resolves variant clones to base ids', () => {
    const doc = fixture()
    expect(canonicalSourceId(doc, 'vtitle')).toBe('title')
    expect(canonicalSourceId(doc, 'title')).toBe('title')
    expect(canonicalSourceId(doc, 'missing')).toBe('missing')
  })

  it('overrideFor matches via refId then own id', () => {
    const doc = fixture()
    const inst = doc.nodes.inst
    expect(overrideFor(inst, doc.nodes.vtitle)?.text).toBe('Overridden!')
    expect(overrideFor(inst, doc.nodes.title)?.text).toBe('Overridden!')
  })

  it('overrides keyed by base ids apply on the base definition', () => {
    const doc = fixture()
    const resolved = resolveNode(doc, 'inst')
    expect(resolved?.children[0]?.text).toBe('Overridden!')
  })

  it('overrides survive switching to a variant', () => {
    const doc = fixture()
    doc.nodes.inst = { ...doc.nodes.inst, variantId: 'cmpv' }
    const resolved = resolveNode(doc, 'inst')
    // Renders the variant's structure, but the override still applies.
    expect(resolved?.children[0]?.sourceId).toBe('vtitle')
    expect(resolved?.children[0]?.text).toBe('Overridden!')
  })

  it('without refId the override is (correctly) not applied', () => {
    const doc = fixture()
    delete doc.nodes.vtitle.refId
    doc.nodes.inst = { ...doc.nodes.inst, variantId: 'cmpv' }
    const resolved = resolveNode(doc, 'inst')
    expect(resolved?.children[0]?.text).toBe('Variant title')
  })
})
