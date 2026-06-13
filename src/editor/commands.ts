import { collectSubtree, DESIGN_SYSTEM_PAGE_ID } from './model/doc'
import { cloneSubtree } from './model/factory'
import { genId } from './model/ids'
import { exportHtml } from './compiler/export'
import { defaultName, parseHtml } from './compiler/parse'
import { SVG_TAGS } from './compiler/allowlist'
import { px, fmtPx } from './canvas/geometry'
import type { Rect } from './canvas/geometry'
import type { EditorStore } from './store/editorStore'
import type { NodeId, NodeLocation, NodeModel, NodePropsPatch, Op, TransactionSource } from './model/types'

/**
 * Shared editing commands over the store. Both human input (keyboard,
 * toolbar, inspector) and AI/MCP tools go through these, so every mutation is
 * one undoable transaction regardless of who asked for it.
 */

export interface CommandCtx {
  store: EditorStore
  /** World-space AABB of a rendered node, when the canvas is mounted. */
  getRect?: (pathId: string) => Rect | null
  source?: TransactionSource
}

const src = (ctx: CommandCtx) => ctx.source ?? 'user'

export function deleteNodes(ctx: CommandCtx, ids: NodeId[]): NodeId[] {
  const { store } = ctx
  const roots = topMostOnly(store, ids).filter((id) => store.doc.nodes[id])
  if (roots.length === 0) return []
  store.apply(`Delete ${roots.length} layer${roots.length > 1 ? 's' : ''}`,
    roots.map((id) => ({ t: 'remove', id }) as Op), src(ctx))
  return roots
}

export function duplicateNodes(ctx: CommandCtx, ids: NodeId[], offset = 10): NodeId[] {
  const { store } = ctx
  const roots = topMostOnly(store, ids).filter((id) => store.doc.nodes[id])
  const ops: Op[] = []
  const newIds: NodeId[] = []
  for (const id of roots) {
    const loc = locate(store, id)
    if (!loc) continue
    const clone = cloneSubtree(store.doc.nodes, id)
    const root = clone.nodes.find((n) => n.id === clone.rootId)
    if (root && offset !== 0) {
      const left = px(root.style.left)
      const top = px(root.style.top)
      if (left !== null) root.style.left = fmtPx(left + offset)
      if (top !== null) root.style.top = fmtPx(top + offset)
    }
    ops.push({ t: 'insertTree', nodes: clone.nodes, rootId: clone.rootId, at: { ...loc, index: loc.index + 1 } })
    newIds.push(clone.rootId)
  }
  if (ops.length === 0) return []
  store.apply(`Duplicate ${newIds.length}`, ops, src(ctx))
  return newIds
}

export function groupNodes(ctx: CommandCtx, ids: NodeId[]): NodeId | null {
  const { store } = ctx
  const roots = topMostOnly(store, ids)
  if (roots.length < 2) return null
  const parentId = store.doc.nodes[roots[0]].parent
  if (!roots.every((id) => store.doc.nodes[id].parent === parentId)) return null

  // Bounds from inline px positions; fall back to live DOM rects.
  const boxes = roots.map((id) => {
    const style = store.doc.nodes[id].style
    const left = px(style.left)
    const top = px(style.top)
    const width = px(style.width)
    const height = px(style.height)
    if (left !== null && top !== null) {
      return { id, x: left, y: top, width: width ?? 100, height: height ?? 100 }
    }
    const rect = ctx.getRect?.(id)
    return rect ? { id, ...rect } : null
  })
  if (boxes.some((b) => b === null)) return null
  const list = boxes as Array<{ id: NodeId; x: number; y: number; width: number; height: number }>
  const gx = Math.min(...list.map((b) => b.x))
  const gy = Math.min(...list.map((b) => b.y))
  const gw = Math.max(...list.map((b) => b.x + b.width)) - gx
  const gh = Math.max(...list.map((b) => b.y + b.height)) - gy

  const group: NodeModel = {
    id: genId(),
    name: 'Group',
    tag: 'div',
    attrs: {},
    style: { position: 'absolute', left: fmtPx(gx), top: fmtPx(gy), width: fmtPx(gw), height: fmtPx(gh) },
    classes: [],
    children: [],
    parent: null,
    visible: true,
    locked: false,
  }
  const loc = locate(store, roots[0])
  if (!loc) return null
  const ops: Op[] = [{ t: 'insertTree', nodes: [group], rootId: group.id, at: loc }]
  roots.forEach((id, i) => {
    const b = list.find((x) => x.id === id)
    if (!b) return
    ops.push({ t: 'move', id, to: { kind: 'node', parent: group.id, index: i } })
    ops.push({ t: 'setStyle', id, set: { left: fmtPx(b.x - gx), top: fmtPx(b.y - gy) } })
  })
  store.apply('Group', ops, src(ctx))
  store.setSelection([group.id])
  store.recordSelectionAfter()
  return group.id
}

export function ungroupNodes(ctx: CommandCtx, ids: NodeId[]): NodeId[] {
  const { store } = ctx
  const released: NodeId[] = []
  const ops: Op[] = []
  for (const id of topMostOnly(store, ids)) {
    const group = store.doc.nodes[id]
    if (!group || group.children.length === 0 || group.isArtboard) continue
    const loc = locate(store, id)
    if (!loc) continue
    const gx = px(group.style.left) ?? 0
    const gy = px(group.style.top) ?? 0
    ;[...group.children].forEach((childId, i) => {
      const child = store.doc.nodes[childId]
      const left = px(child.style.left)
      const top = px(child.style.top)
      ops.push({ t: 'move', id: childId, to: { ...loc, index: loc.index + 1 + i } })
      if (left !== null && top !== null) {
        ops.push({ t: 'setStyle', id: childId, set: { left: fmtPx(left + gx), top: fmtPx(top + gy) } })
      }
      released.push(childId)
    })
    ops.push({ t: 'remove', id })
  }
  if (ops.length === 0) return []
  store.apply('Ungroup', ops, src(ctx))
  store.setSelection(released)
  store.recordSelectionAfter()
  return released
}

export type ZOrder = 'forward' | 'backward' | 'front' | 'back'

export function reorderNodes(ctx: CommandCtx, ids: NodeId[], dir: ZOrder) {
  const { store } = ctx
  const ops: Op[] = []
  for (const id of topMostOnly(store, ids)) {
    const loc = locate(store, id)
    if (!loc) continue
    const siblings =
      loc.kind === 'page'
        ? store.doc.pages.find((p) => p.id === loc.pageId)?.children ?? []
        : store.doc.nodes[loc.parent].children
    const last = siblings.length - 1
    const index =
      dir === 'front' ? last : dir === 'back' ? 0
      : dir === 'forward' ? Math.min(last, loc.index + 1) : Math.max(0, loc.index - 1)
    if (index !== loc.index) ops.push({ t: 'move', id, to: { ...loc, index } })
  }
  if (ops.length > 0) store.apply(`Reorder ${dir}`, ops, src(ctx))
}

export function nudgeNodes(ctx: CommandCtx, ids: NodeId[], dx: number, dy: number) {
  const { store } = ctx
  const ops: Op[] = []
  for (const id of topMostOnly(store, ids)) {
    const node = store.doc.nodes[id]
    if (!node || node.locked) continue
    const left = px(node.style.left)
    const top = px(node.style.top)
    if (left === null || top === null) continue
    ops.push({ t: 'setStyle', id, set: { left: fmtPx(left + dx), top: fmtPx(top + dy) } })
  }
  if (ops.length > 0) store.apply('Nudge', ops, src(ctx))
}

export function setTextContent(ctx: CommandCtx, id: NodeId, text: string) {
  const { store } = ctx
  const node = store.doc.nodes[id]
  if (!node) return
  const patch: NodePropsPatch = { text }
  // If the layer name was auto-derived from the old text (never hand-named),
  // refresh it from the new text so the tree doesn't show stale labels.
  const oldText = node.text ?? ''
  if (node.name === defaultName(node.tag, oldText)) {
    patch.name = defaultName(node.tag, text)
  }
  if (node.children.length > 0) {
    // Editing flattened rich text: replace children with the plain string.
    const ops: Op[] = node.children.map((c) => ({ t: 'remove', id: c }) as Op)
    ops.push({ t: 'setProps', id, patch })
    store.apply('Edit text', ops, src(ctx))
  } else {
    store.apply('Edit text', [{ t: 'setProps', id, patch }], src(ctx))
  }
}

export interface InsertResult {
  rootIds: NodeId[]
  dropped: string[]
  /** Every node created by the parse, in document order. */
  nodes: NodeModel[]
  /** Non-fatal sanitizer warnings, when the parser reports them. */
  warnings?: string[]
}

/** Parse untrusted HTML and insert it at a location, as one transaction. */
export function insertHtml(
  ctx: CommandCtx,
  html: string,
  at: NodeLocation,
  label = 'Insert',
): InsertResult {
  const { store } = ctx
  const result = parseHtml(html, { isIdTaken: (id) => Boolean(store.doc.nodes[id]) })
  const { nodes, rootIds, dropped } = result
  const warnings = (result as { warnings?: string[] }).warnings
  if (rootIds.length === 0) return { rootIds: [], dropped, nodes, ...(warnings?.length ? { warnings } : {}) }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const collect = (id: NodeId): NodeModel[] => {
    const node = byId.get(id)
    if (!node) return []
    return [node, ...node.children.flatMap(collect)]
  }
  const ops: Op[] = rootIds.map((rootId, i) => ({
    t: 'insertTree',
    nodes: collect(rootId),
    rootId,
    at: { ...at, index: at.index + i },
  }))
  store.apply(label, ops, src(ctx))
  return { rootIds, dropped, nodes, ...(warnings?.length ? { warnings } : {}) }
}

/**
 * Replace a node with parsed HTML at the same location, as one transaction.
 * Shared by AI write_html(replace) and the inspector's icon swap.
 */
export function replaceNodeHtml(
  ctx: CommandCtx,
  targetId: NodeId,
  html: string,
  label = 'Replace',
): InsertResult {
  const { store } = ctx
  const target = store.doc.nodes[targetId]
  const at = locate(store, targetId)
  if (!target || !at) return { rootIds: [], dropped: [], nodes: [] }
  const result = parseHtml(html, { isIdTaken: (id) => Boolean(store.doc.nodes[id]) })
  const { nodes, rootIds, dropped } = result
  const warnings = (result as { warnings?: string[] }).warnings
  if (rootIds.length === 0) return { rootIds: [], dropped, nodes, ...(warnings?.length ? { warnings } : {}) }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const collect = (id: NodeId): NodeModel[] => {
    const node = byId.get(id)
    return node ? [node, ...node.children.flatMap(collect)] : []
  }
  const ops: Op[] = [{ t: 'remove', id: targetId }]
  rootIds.forEach((rootId, i) => {
    ops.push({ t: 'insertTree', nodes: collect(rootId), rootId, at: { ...at, index: at.index + i } })
  })
  store.apply(label, ops, src(ctx))
  return { rootIds, dropped, nodes, ...(warnings?.length ? { warnings } : {}) }
}

/** Serialize nodes to sanitized HTML (the copy payload). */
export function copyNodes(ctx: CommandCtx, ids: NodeId[]): string {
  const { store } = ctx
  return topMostOnly(store, ids)
    .filter((id) => store.doc.nodes[id])
    .map((id) => exportHtml(store.doc, id))
    .join('\n')
}

export function pasteHtml(ctx: CommandCtx, html: string, offset = 16): NodeId[] {
  const { store } = ctx
  const selection = store.ui.selection
  let at: NodeLocation | null = null
  if (selection.length > 0) {
    const first = store.doc.nodes[selection[0]]
    if (first?.parent) {
      const parent = store.doc.nodes[first.parent]
      at = { kind: 'node', parent: first.parent, index: parent.children.length }
    }
  }
  if (!at) {
    const page = store.activePage()
    const artboard = page.children.find((id) => store.doc.nodes[id]?.isArtboard)
    at = artboard
      ? { kind: 'node', parent: artboard, index: store.doc.nodes[artboard].children.length }
      : { kind: 'page', pageId: page.id, index: page.children.length }
  }
  const { rootIds } = insertHtml(ctx, html, at, 'Paste')
  if (rootIds.length > 0 && offset !== 0) {
    const ops: Op[] = []
    for (const id of rootIds) {
      const style = store.doc.nodes[id].style
      const left = px(style.left)
      const top = px(style.top)
      if (left !== null && top !== null) {
        ops.push({ t: 'setStyle', id, set: { left: fmtPx(left + offset), top: fmtPx(top + offset) } })
      }
    }
    // Same user action as the paste; fold into one undo step is nicer, but a
    // separate offset transaction keeps insertHtml reusable. Acceptable.
    if (ops.length > 0) store.apply('Paste offset', ops, src(ctx))
  }
  store.setSelection(rootIds)
  store.recordSelectionAfter()
  return rootIds
}

export function renameNode(ctx: CommandCtx, id: NodeId, name: string) {
  ctx.store.apply('Rename', [{ t: 'setProps', id, patch: { name } }], src(ctx))
}

export function setVisibility(ctx: CommandCtx, id: NodeId, visible: boolean) {
  ctx.store.apply(visible ? 'Show' : 'Hide', [{ t: 'setProps', id, patch: { visible } }], src(ctx))
}

export function setLocked(ctx: CommandCtx, id: NodeId, locked: boolean) {
  ctx.store.apply(locked ? 'Lock' : 'Unlock', [{ t: 'setProps', id, patch: { locked } }], src(ctx))
}

// --- pages ------------------------------------------------------------------

/** The hidden component-definition page is never a "user page". */
export const isDesignSystemPage = (pageId: string) => pageId === DESIGN_SYSTEM_PAGE_ID

/** Pages a user can navigate, rename, and delete — excludes the Design System page. */
export function userPages(store: EditorStore) {
  return store.doc.pages.filter((p) => !isDesignSystemPage(p.id))
}

export interface PageGuardError {
  ok: false
  reason: string
}

/**
 * Delete a page and all its contents in one undoable transaction. Refuses the
 * Design System page outright and the last remaining USER page (the hidden
 * Design System page must not satisfy the guard). Returns the deleted page id.
 */
export function deletePage(
  ctx: CommandCtx,
  pageId: string,
): { ok: true; deletedPageId: string; activePageId: string } | PageGuardError {
  const { store } = ctx
  const page = store.doc.pages.find((p) => p.id === pageId)
  if (!page) return { ok: false, reason: `Unknown page: ${pageId}` }
  if (isDesignSystemPage(pageId)) {
    return { ok: false, reason: 'The Design System page cannot be deleted (it holds component definitions).' }
  }
  if (userPages(store).length <= 1) {
    return { ok: false, reason: 'Cannot delete the only page. A document must keep at least one page.' }
  }
  const ops: Op[] = page.children.map((cid) => ({ t: 'remove', id: cid }) as Op)
  ops.push({ t: 'removePage', id: pageId })
  store.apply(`Delete page ${page.name}`, ops, src(ctx))
  return { ok: true, deletedPageId: pageId, activePageId: store.doc.activePageId }
}

/** Rename a page. Refuses the Design System page. */
export function renamePage(
  ctx: CommandCtx,
  pageId: string,
  name: string,
): { ok: true; name: string } | PageGuardError {
  const { store } = ctx
  const page = store.doc.pages.find((p) => p.id === pageId)
  if (!page) return { ok: false, reason: `Unknown page: ${pageId}` }
  if (isDesignSystemPage(pageId)) {
    return { ok: false, reason: 'The Design System page cannot be renamed (it holds component definitions).' }
  }
  const clean = name.slice(0, 60)
  if (!clean.trim()) return { ok: false, reason: 'name is required' }
  store.apply(`Rename page ${clean}`, [{ t: 'setPageName', id: pageId, name: clean }], src(ctx))
  return { ok: true, name: clean }
}

/**
 * Deep-copy a page: clone every top-level subtree with fresh ids (reusing the
 * duplicate machinery), preserve relative layout, append the new page right
 * after the source, and switch to it. Instances stay linked to the same
 * components. One undoable transaction; undo removes the page cleanly.
 */
export function duplicatePage(
  ctx: CommandCtx,
  pageId: string,
  name?: string,
): { ok: true; pageId: string; name: string; nodeCount: number } | PageGuardError {
  const { store } = ctx
  const source = store.doc.pages.find((p) => p.id === pageId)
  if (!source) return { ok: false, reason: `Unknown page: ${pageId}` }
  const newPageId = genId('page')
  const newName = name?.slice(0, 60).trim() || `${source.name} copy`
  const index = store.doc.pages.findIndex((p) => p.id === pageId) + 1
  const ops: Op[] = [{ t: 'addPage', page: { id: newPageId, name: newName, children: [] }, index }]
  let nodeCount = 0
  source.children.forEach((childId, i) => {
    const clone = cloneSubtree(store.doc.nodes, childId)
    nodeCount += clone.nodes.length
    ops.push({
      t: 'insertTree',
      nodes: clone.nodes,
      rootId: clone.rootId,
      at: { kind: 'page', pageId: newPageId, index: i },
    })
  })
  store.apply(`Duplicate page ${source.name}`, ops, src(ctx))
  store.setActivePage(newPageId)
  return { ok: true, pageId: newPageId, name: newName, nodeCount }
}

// --- helpers ---------------------------------------------------------------

export function locate(store: EditorStore, id: NodeId): NodeLocation | null {
  const node = store.doc.nodes[id]
  if (!node) return null
  if (node.parent) {
    const index = store.doc.nodes[node.parent]?.children.indexOf(id) ?? -1
    return index >= 0 ? { kind: 'node', parent: node.parent, index } : null
  }
  for (const page of store.doc.pages) {
    const index = page.children.indexOf(id)
    if (index >= 0) return { kind: 'page', pageId: page.id, index }
  }
  return null
}

const NEVER_CONTAINERS = new Set(['img', 'br', 'hr', 'input', 'textarea', 'select', 'option'])

const TEXT_LEAF_TAGS = new Set([
  'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'label',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'code', 'blockquote',
])

/** Text-like leaf: one-click selection skips these (double-click targets them). */
export function isTextNode(node: NodeModel): boolean {
  if (node.text !== undefined) return true
  return TEXT_LEAF_TAGS.has(node.tag) && node.children.length === 0
}

/** Any element of the sanitized SVG subset. */
export function isSvgNode(node: NodeModel): boolean {
  return SVG_TAGS.has(node.tag)
}

/**
 * Whether a node can receive dropped/drawn children. Artboards always can;
 * otherwise any non-void element that isn't a text leaf and either already
 * has children or declares a layout (flex/grid). Bare shape divs stay solid.
 */
export function canReceiveChildren(node: NodeModel): boolean {
  if (node.componentId || node.text !== undefined || NEVER_CONTAINERS.has(node.tag)) return false
  // A set frame holds only variant roots, added via createVariant — not drops.
  if (node.isComponentSet) return false
  if (SVG_TAGS.has(node.tag)) return false // vectors edit as a unit
  if (node.isArtboard || node.children.length > 0) return true
  return isLayoutContainer(node)
}

/** Flex/grid container per the model (inline style or Tailwind classes). */
export function isLayoutContainer(node: NodeModel): boolean {
  const d = node.style.display
  if (d === 'flex' || d === 'grid' || d === 'inline-flex') return true
  return node.classes.some((c) => c === 'flex' || c === 'inline-flex' || c === 'grid')
}

/** Drop ids that are descendants of other ids in the set. */
export function topMostOnly(store: EditorStore, ids: NodeId[]): NodeId[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    let cur = store.doc.nodes[id]?.parent ?? null
    while (cur) {
      if (set.has(cur)) return false
      cur = store.doc.nodes[cur]?.parent ?? null
    }
    return true
  })
}

export function subtreeNodes(store: EditorStore, id: NodeId): NodeModel[] {
  return collectSubtree(store.doc, id)
}
