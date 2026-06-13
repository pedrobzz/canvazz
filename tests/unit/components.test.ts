import { afterEach, describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { EditorStore } from '#/editor/store/editorStore'
import {
  isIconNode, setInstanceIconOverride, setInstanceOverride,
} from '#/editor/components/componentCommands'
import {
  canonicalSourceId, overrideFor, resolveNode, setIconChildrenResolver,
} from '#/editor/model/instances'
import type { IconChildrenResolver } from '#/editor/model/instances'
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

/** A component with an icon slot (an <svg> stamped with data-cz-icon) + instance. */
function iconStore(): EditorStore {
  const doc = emptyDocument('d', 'T')
  doc.nodes = {
    root: node({ id: 'root', tag: 'div', isComponentRoot: true, children: ['icon'] }),
    icon: node({
      id: 'icon', tag: 'svg', parent: 'root',
      attrs: { 'data-cz-icon': 'dollarsign', 'data-cz-variant': 'monochrome', width: '24', viewBox: '0 0 24 24' },
      children: ['p0'],
    }),
    p0: node({ id: 'p0', tag: 'path', parent: 'icon', attrs: { d: 'M0 0' } }),
    label: node({ id: 'label', tag: 'span', isComponentRoot: false, text: 'KPI' }),
    inst: node({ id: 'inst', tag: 'div', componentId: 'cmp' }),
  }
  doc.components = { cmp: { id: 'cmp', name: 'Card', rootId: 'root' } }
  doc.pages[0].children = ['root', 'inst']
  const store = new EditorStore()
  store.replaceDocument(doc)
  return store
}

describe('per-instance icon swap (#16a)', () => {
  // A stub resolver standing in for the real SF registry: returns a single
  // <path> whose d encodes the requested symbol, so we can assert per-instance.
  const stub: IconChildrenResolver = (name) => ({
    attrs: { viewBox: '0 0 24 24' },
    children: [{
      pathId: 'g', sourceId: 'g', instanceId: null, name: 'Path', tag: 'path',
      attrs: { d: `glyph:${name}` }, style: {}, classes: [], visible: true, locked: false, children: [],
    }],
  })
  afterEach(() => setIconChildrenResolver(() => null))

  it('isIconNode recognises data-cz-icon svgs only', () => {
    const store = iconStore()
    expect(isIconNode(store.doc.nodes.icon)).toBe(true)
    expect(isIconNode(store.doc.nodes.label)).toBe(false)
    expect(isIconNode(store.doc.nodes.root)).toBe(false)
    expect(isIconNode(undefined)).toBe(false)
  })

  it('rejects icon overrides on non-icon nodes', () => {
    const store = iconStore()
    const res = setInstanceIconOverride({ store }, 'inst', 'root', 'heart.fill')
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('not an icon node') })
    expect(store.doc.nodes.inst.overrides).toBeUndefined()
  })

  it('stores the swap as a data-cz-icon attrs override on the canonical key', () => {
    const store = iconStore()
    const res = setInstanceIconOverride({ store }, 'inst', 'icon', 'heart.fill', 'monochrome')
    expect(res).toEqual({ ok: true })
    expect(store.doc.nodes.inst.overrides?.icon?.attrs).toEqual({
      'data-cz-icon': 'heart.fill', 'data-cz-variant': 'monochrome',
    })
  })

  it('expansion renders the overridden glyph per instance', () => {
    setIconChildrenResolver(stub)
    const store = iconStore()
    setInstanceIconOverride({ store }, 'inst', 'icon', 'heart.fill')
    const resolved = resolveNode(store.doc, 'inst')
    const iconNode = resolved?.children[0]
    expect(iconNode?.tag).toBe('svg')
    // The def's static path is replaced by the regenerated glyph.
    expect(iconNode?.children[0]?.attrs.d).toBe('glyph:heart.fill')
  })

  it('four instances of one card show four different icons', () => {
    setIconChildrenResolver(stub)
    const store = iconStore()
    const symbols = ['heart.fill', 'star.fill', 'bolt.fill', 'flame.fill']
    const instIds = symbols.map((sym, i) => {
      const id = `inst${i}`
      store.replaceDocument({
        ...store.doc,
        nodes: { ...store.doc.nodes, [id]: node({ id, tag: 'div', componentId: 'cmp' }) },
        pages: [{ ...store.doc.pages[0], children: [...store.doc.pages[0].children, id] }],
      })
      setInstanceIconOverride({ store }, id, 'icon', sym)
      return id
    })
    const glyphs = instIds.map((id) => resolveNode(store.doc, id)?.children[0]?.children[0]?.attrs.d)
    expect(glyphs).toEqual(symbols.map((s) => `glyph:${s}`))
  })

  it('is undoable', () => {
    const store = iconStore()
    setInstanceIconOverride({ store }, 'inst', 'icon', 'heart.fill')
    expect(store.doc.nodes.inst.overrides?.icon).toBeDefined()
    store.undo()
    expect(store.doc.nodes.inst.overrides?.icon).toBeUndefined()
  })
})

describe('token values in instance overrides (#16b)', () => {
  it('keeps var(--token) style values live (same sanitizer as update_styles)', () => {
    const doc = emptyDocument('d', 'T')
    doc.nodes = {
      root: node({ id: 'root', tag: 'div', isComponentRoot: true, children: ['t'] }),
      t: node({ id: 't', tag: 'span', parent: 'root', text: 'x', style: { color: '#000' } }),
      inst: node({ id: 'inst', tag: 'div', componentId: 'cmp' }),
    }
    doc.components = { cmp: { id: 'cmp', name: 'C', rootId: 'root' } }
    doc.pages[0].children = ['root', 'inst']
    const store = new EditorStore()
    store.replaceDocument(doc)

    const ok = setInstanceOverride({ store }, 'inst', 't', { style: { color: 'var(--brand)' } })
    expect(ok).toBe(true)
    expect(store.doc.nodes.inst.overrides?.t?.style?.color).toBe('var(--brand)')
    const resolved = resolveNode(store.doc, 'inst')
    expect(resolved?.children[0]?.style.color).toBe('var(--brand)')
  })

  it('drops unsafe style values while keeping safe ones', () => {
    const doc = emptyDocument('d', 'T')
    doc.nodes = {
      root: node({ id: 'root', tag: 'div', isComponentRoot: true, children: ['t'] }),
      t: node({ id: 't', tag: 'span', parent: 'root', text: 'x' }),
      inst: node({ id: 'inst', tag: 'div', componentId: 'cmp' }),
    }
    doc.components = { cmp: { id: 'cmp', name: 'C', rootId: 'root' } }
    doc.pages[0].children = ['root', 'inst']
    const store = new EditorStore()
    store.replaceDocument(doc)

    setInstanceOverride({ store }, 'inst', 't', {
      style: { color: 'var(--brand)', background: 'url(javascript:alert(1))' },
    })
    const style = store.doc.nodes.inst.overrides?.t?.style ?? {}
    expect(style.color).toBe('var(--brand)')
    expect(style.background).toBeUndefined()
  })
})
