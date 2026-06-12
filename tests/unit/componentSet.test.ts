import { describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { EditorStore } from '#/editor/store/editorStore'
import { createVariant, deleteComponent } from '#/editor/components/componentCommands'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

function node(partial: Partial<NodeModel> & Pick<NodeModel, 'id' | 'tag'>): NodeModel {
  return {
    name: partial.id, attrs: {}, style: {}, classes: [], children: [],
    parent: null, visible: true, locked: false, ...partial,
  } as NodeModel
}

/** A store holding one lone (not-yet-a-set) component on the page. */
function storeWithComponent(): EditorStore {
  const doc: DocumentModel = emptyDocument('d', 'T')
  doc.nodes = {
    root: node({ id: 'root', tag: 'div', isComponentRoot: true, children: ['t'], style: { position: 'absolute', left: '100px', top: '80px', width: '200px' } }),
    t: node({ id: 't', tag: 'span', parent: 'root', text: 'Hi' }),
  }
  doc.components = { cmp: { id: 'cmp', name: 'Card', rootId: 'root' } }
  doc.pages[0].children = ['root']
  const store = new EditorStore()
  store.replaceDocument(doc)
  return store
}

describe('createVariant — Figma-style set frames', () => {
  it('first variant wraps the base + clone into a real set node', () => {
    const store = storeWithComponent()
    const res = createVariant({ store }, 'cmp', 'alt')
    expect(res).toBeTruthy()
    const set = Object.values(store.doc.componentSets)[0]
    expect(set.variantIds).toEqual(['cmp', res!.variantId])

    const setNode = store.doc.nodes[set.nodeId]
    expect(setNode.isComponentSet).toBe(true)
    expect(setNode.children).toEqual(['root', res!.rootId])

    // Base root is re-homed into the set, shedding its absolute placement.
    expect(store.doc.nodes.root.parent).toBe(set.nodeId)
    expect(store.doc.nodes.root.style.position).toBeUndefined()
    expect(store.doc.nodes.root.style.left).toBeUndefined()
    // Clone flows too, but keeps its intrinsic size.
    expect(store.doc.nodes[res!.rootId].style.position).toBeUndefined()
    expect(store.doc.nodes[res!.rootId].style.width).toBe('200px')

    // The page now holds the set node in place of the loose root.
    expect(store.doc.pages[0].children).toEqual([set.nodeId])
  })

  it('a second variant appends as another set child', () => {
    const store = storeWithComponent()
    const v1 = createVariant({ store }, 'cmp', 'alt')!
    const v2 = createVariant({ store }, 'cmp', 'dark')!
    const set = Object.values(store.doc.componentSets)[0]
    expect(set.variantIds).toEqual(['cmp', v1.variantId, v2.variantId])
    expect(store.doc.nodes[set.nodeId].children).toEqual(['root', v1.rootId, v2.rootId])
  })

  it('deleting the last variant removes the empty set frame', () => {
    const store = storeWithComponent()
    const v1 = createVariant({ store }, 'cmp', 'alt')!
    const set = Object.values(store.doc.componentSets)[0]

    expect(deleteComponent({ store }, v1.variantId)).toEqual({ ok: true })
    expect(store.doc.nodes[v1.rootId]).toBeUndefined()
    expect(store.doc.nodes[set.nodeId]).toBeDefined() // base still there

    expect(deleteComponent({ store }, 'cmp')).toEqual({ ok: true })
    expect(store.doc.nodes.root).toBeUndefined()
    expect(store.doc.nodes[set.nodeId]).toBeUndefined() // empty set frame gone
  })

  it('the whole wrap is one undoable transaction', () => {
    const store = storeWithComponent()
    const res = createVariant({ store }, 'cmp', 'alt')!
    const setNodeId = Object.values(store.doc.componentSets)[0].nodeId
    store.undo()
    // Set frame + clone removed; the base root is restored to the page with
    // its original placement, and the component is lone again.
    expect(store.doc.nodes[setNodeId]).toBeUndefined()
    expect(store.doc.nodes[res.rootId]).toBeUndefined()
    expect(store.doc.pages[0].children).toEqual(['root'])
    expect(store.doc.nodes.root.parent).toBeNull()
    expect(store.doc.nodes.root.style.position).toBe('absolute')
    expect(store.doc.components.cmp.setId).toBeUndefined()
  })
})
