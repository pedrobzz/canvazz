import { beforeEach, describe, expect, it } from 'vitest'
import { EditorStore } from '#/editor/store/editorStore'
import { DESIGN_SYSTEM_PAGE_ID, emptyDocument } from '#/editor/model/doc'
import { deletePage, renamePage } from '#/editor/commands'
import { createArtboard } from '#/editor/model/factory'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

/** A doc with one user page (an artboard + a child) plus the Design System page. */
function docWithDesignSystem(): DocumentModel {
  const doc = emptyDocument('d', 'T')
  const artboard = createArtboard('Home', { x: 0, y: 0, width: 375, height: 667 })
  const child: NodeModel = {
    id: 'child-1', name: 'Card', tag: 'div', attrs: {}, style: { left: '10px', top: '10px' },
    classes: [], children: [], parent: artboard.id, visible: true, locked: false,
  }
  artboard.children = [child.id]
  doc.nodes[artboard.id] = artboard
  doc.nodes[child.id] = child
  doc.pages[0].children = [artboard.id]
  // A main component lives on the hidden Design System page.
  const main: NodeModel = {
    id: 'main-1', name: 'Btn', tag: 'div', attrs: {}, style: {}, classes: [],
    children: [], parent: null, visible: true, locked: false, isComponentRoot: true,
  }
  doc.nodes[main.id] = main
  doc.pages.push({ id: DESIGN_SYSTEM_PAGE_ID, name: 'Design System', children: [main.id] })
  return doc
}

describe('deletePage guard', () => {
  let store: EditorStore
  beforeEach(() => {
    store = new EditorStore(docWithDesignSystem())
  })

  it('refuses to delete the only USER page even though the Design System page exists', () => {
    const result = deletePage({ store, source: 'ai' }, 'page_1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/only page/i)
    // Page and its contents are untouched.
    expect(store.doc.pages.some((p) => p.id === 'page_1')).toBe(true)
    expect(store.doc.nodes['child-1']).toBeDefined()
  })

  it('refuses to delete the Design System page outright', () => {
    const result = deletePage({ store, source: 'ai' }, DESIGN_SYSTEM_PAGE_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Design System/i)
    expect(store.doc.pages.some((p) => p.id === DESIGN_SYSTEM_PAGE_ID)).toBe(true)
  })

  it('deletes a non-last user page (with contents) and lands on a real page', () => {
    // Add a second user page so deletion is allowed.
    store.apply('add', [{ t: 'addPage', page: { id: 'page_2', name: 'Page 2', children: [] }, index: 1 }], 'user')
    store.setActivePage('page_1')
    const result = deletePage({ store, source: 'ai' }, 'page_1')
    expect(result.ok).toBe(true)
    expect(store.doc.pages.some((p) => p.id === 'page_1')).toBe(false)
    expect(store.doc.nodes['child-1']).toBeUndefined()
    // Active page must not fall onto the hidden Design System page.
    expect(store.doc.activePageId).not.toBe(DESIGN_SYSTEM_PAGE_ID)
    expect(store.doc.activePageId).toBe('page_2')
  })

  it('delete + undo restores the page and its contents', () => {
    store.apply('add', [{ t: 'addPage', page: { id: 'page_2', name: 'Page 2', children: [] }, index: 1 }], 'user')
    deletePage({ store, source: 'ai' }, 'page_1')
    expect(store.doc.nodes['child-1']).toBeUndefined()
    store.undo()
    expect(store.doc.pages.some((p) => p.id === 'page_1')).toBe(true)
    expect(store.doc.nodes['child-1']).toBeDefined()
  })
})

describe('renamePage guard', () => {
  it('renames a user page', () => {
    const store = new EditorStore(docWithDesignSystem())
    const result = renamePage({ store, source: 'ai' }, 'page_1', 'Landing')
    expect(result.ok).toBe(true)
    expect(store.doc.pages.find((p) => p.id === 'page_1')?.name).toBe('Landing')
  })

  it('refuses to rename the Design System page', () => {
    const store = new EditorStore(docWithDesignSystem())
    const result = renamePage({ store, source: 'ai' }, DESIGN_SYSTEM_PAGE_ID, 'Hacked')
    expect(result.ok).toBe(false)
    expect(store.doc.pages.find((p) => p.id === DESIGN_SYSTEM_PAGE_ID)?.name).toBe('Design System')
  })
})
