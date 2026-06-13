import { beforeEach, describe, expect, it } from 'vitest'
import { aiToolExecutors } from '#/editor/ai/aiTools'
import { editorStore } from '#/editor/store/editorStore'
import { emptyDocument } from '#/editor/model/doc'
import { createArtboard } from '#/editor/model/factory'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

/** Load a doc into the shared editorStore (executors operate on the singleton). */
function load(doc: DocumentModel) {
  editorStore.replaceDocument(doc)
}

function call(tool: string, args: Record<string, unknown> = {}) {
  return aiToolExecutors[tool](args) as Record<string, unknown>
}

/** Doc with one artboard "Home" holding a labeled heading + a button. */
function docWithArtboard(): DocumentModel {
  const doc = emptyDocument('d', 'T')
  const artboard = createArtboard('Home', { x: 0, y: 0, width: 375, height: 667 })
  const heading: NodeModel = {
    id: 'h-1', name: 'at the speed of thought', tag: 'h1', attrs: {},
    style: {}, classes: [], children: [], parent: artboard.id, visible: true, locked: false,
    text: 'at the speed of thought',
  }
  const button: NodeModel = {
    id: 'btn-1', name: 'Submit', tag: 'button', attrs: {},
    style: {}, classes: [], children: [], parent: artboard.id, visible: true, locked: false, text: 'Submit',
  }
  artboard.children = [heading.id, button.id]
  doc.nodes[artboard.id] = artboard
  doc.nodes[heading.id] = heading
  doc.nodes[button.id] = button
  doc.pages[0].children = [artboard.id]
  return doc
}

describe('write_html createdNodes (#4)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('returns {id,name,tag} for every created node, including labeled slots', () => {
    const res = call('write_html', {
      targetId: 'h-1',
      mode: 'after',
      html: '<div data-cz-name="Slot"><span data-cz-name="Icon">x</span></div>',
    })
    const created = res.createdNodes as Array<{ id: string; name: string; tag: string }>
    expect(created.length).toBe(2)
    const names = created.map((c) => c.name)
    expect(names).toContain('Slot')
    expect(names).toContain('Icon')
    expect(created.every((c) => typeof c.id === 'string')).toBe(true)
  })
})

describe('write_html replace on an artboard (#5)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('keeps the artboard id/frame/name and swaps only its contents', () => {
    const res = call('write_html', {
      targetId: artboardId(),
      mode: 'replace',
      html: '<div data-cz-name="New screen">Hi</div>',
    })
    expect(res.contentsReplaced).toBe(true)
    const aid = res.artboardId as string
    const artboard = editorStore.doc.nodes[aid]
    expect(artboard).toBeDefined()
    expect(artboard.isArtboard).toBe(true)
    expect(artboard.name).toBe('Home')
    expect(artboard.style.width).toBe('375px')
    // Old children gone, new root inside the artboard.
    expect(editorStore.doc.nodes['h-1']).toBeUndefined()
    expect(artboard.children.length).toBe(1)
    expect(editorStore.doc.nodes[artboard.children[0]].name).toBe('New screen')
    // Artboard still listed by get_basic_info.
    const info = call('get_basic_info') as { artboards: Array<{ id: string }> }
    expect(info.artboards.some((a) => a.id === aid)).toBe(true)
  })
})

function artboardId(): string {
  return editorStore.activePage().children.find((id) => editorStore.doc.nodes[id]?.isArtboard)!
}

describe('targetName addressing (#4c)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('resolves a unique layer name', () => {
    const res = call('write_html', {
      targetName: 'Submit',
      mode: 'after',
      html: '<p data-cz-name="Note">hi</p>',
    })
    expect(res.ok).toBe(true)
    // Inserted as a sibling of the button inside the artboard.
    const note = (res.createdNodes as Array<{ name: string; id: string }>)[0]
    expect(editorStore.doc.nodes[note.id].parent).toBe(artboardId())
  })

  it('errors with matching ids when the name is ambiguous', () => {
    // Make two nodes share a name.
    editorStore.apply('dup name', [{ t: 'setProps', id: 'btn-1', patch: { name: 'at the speed of thought' } }], 'user')
    expect(() => call('write_html', { targetName: 'at the speed of thought', mode: 'after', html: '<p>x</p>' }))
      .toThrow(/Ambiguous/)
  })
})

describe('find_nodes (#4b)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('matches by case-insensitive substring across name and text', () => {
    const res = call('find_nodes', { query: 'SPEED' }) as { matches: Array<{ id: string }> }
    expect(res.matches.map((m) => m.id)).toContain('h-1')
  })

  it('matches by exact name and by tag', () => {
    const byName = call('find_nodes', { name: 'Submit' }) as { matches: Array<{ id: string }> }
    expect(byName.matches.map((m) => m.id)).toEqual(['btn-1'])
    const byTag = call('find_nodes', { tag: 'button' }) as { matches: Array<{ id: string }> }
    expect(byTag.matches.map((m) => m.id)).toEqual(['btn-1'])
  })

  it('honors limit', () => {
    const res = call('find_nodes', { limit: 1 }) as { matches: unknown[]; truncated: boolean }
    expect(res.matches).toHaveLength(1)
    expect(res.truncated).toBe(true)
  })
})

describe('create_artboard_with_html (#15)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('creates a named artboard filled with parsed content in one transaction', () => {
    const res = call('create_artboard_with_html', {
      name: 'Settings', x: 500, y: 0, width: 390, height: 844,
      html: '<div data-cz-name="Header">Settings</div>',
    })
    const aid = res.artboardId as string
    const artboard = editorStore.doc.nodes[aid]
    expect(artboard.isArtboard).toBe(true)
    expect(artboard.name).toBe('Settings')
    expect(artboard.style.width).toBe('390px')
    expect(artboard.children).toHaveLength(1)
    expect((res.createdNodes as Array<{ name: string }>).some((c) => c.name === 'Header')).toBe(true)
    // One undo step removes the whole bootstrap.
    call('undo')
    expect(editorStore.doc.nodes[aid]).toBeUndefined()
  })
})

describe('undo/redo info (#17a)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('undo returns label + changedIds; redo mirrors it', () => {
    editorStore.apply('Recolor', [{ t: 'setStyle', id: 'btn-1', set: { color: '#f00' } }], 'ai')
    const undone = call('undo')
    expect(undone.ok).toBe(true)
    expect(undone.label).toBe('Recolor')
    expect(undone.changedIds).toContain('btn-1')
    expect(editorStore.doc.nodes['btn-1'].style.color).toBeUndefined()
    const redone = call('redo')
    expect(redone.ok).toBe(true)
    expect(redone.label).toBe('Recolor')
    expect(editorStore.doc.nodes['btn-1'].style.color).toBe('#f00')
  })

  it('undo on empty stack reports nothing to undo', () => {
    while ((call('undo') as { ok: boolean }).ok) { /* drain */ }
    expect(call('undo')).toMatchObject({ ok: false })
  })
})

describe('move_nodes placement echo (#17b)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('clamps edge indexes and reports the final placement', () => {
    const res = call('move_nodes', { moves: [{ id: 'h-1', index: 999999 }] }) as {
      placements: Array<{ id: string; parentId: string | null; index: number; clamped: boolean }>
    }
    const p = res.placements[0]
    expect(p.id).toBe('h-1')
    expect(p.parentId).toBe(artboardId())
    expect(p.index).toBe(1) // last of two children
    expect(p.clamped).toBe(true)
  })
})

describe('set_text_content layer-name refresh (#17c)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('refreshes a name that was auto-derived from the old text', () => {
    // h-1 name equals its text → auto-derived.
    call('set_text_content', { id: 'h-1', text: 'Think different' })
    expect(editorStore.doc.nodes['h-1'].name).toBe('Think different')
  })

  it('leaves a hand-named layer untouched', () => {
    editorStore.apply('rename', [{ t: 'setProps', id: 'h-1', patch: { name: 'Hero title' } }], 'user')
    call('set_text_content', { id: 'h-1', text: 'Brand new copy' })
    expect(editorStore.doc.nodes['h-1'].name).toBe('Hero title')
  })
})

describe('duplicate_page tool (#20)', () => {
  beforeEach(() => load(docWithArtboard()))

  it('duplicates the active page, switches to the copy, returns nodeCount', () => {
    const res = call('duplicate_page', { page: 'page_1', name: 'Home copy' })
    expect(res.ok).toBe(true)
    expect(res.name).toBe('Home copy')
    expect(editorStore.doc.activePageId).toBe(res.pageId)
    expect(res.nodeCount).toBe(3) // artboard + heading + button
  })
})
