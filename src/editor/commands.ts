import { collectSubtree } from './model/doc'
import { cloneSubtree } from './model/factory'
import { genId } from './model/ids'
import { exportHtml } from './compiler/export'
import { parseHtml } from './compiler/parse'
import { px, fmtPx } from './canvas/geometry'
import type { Rect } from './canvas/geometry'
import type { EditorStore } from './store/editorStore'
import type { NodeId, NodeLocation, NodeModel, Op, TransactionSource } from './model/types'

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
  if (node.children.length > 0) {
    // Editing flattened rich text: replace children with the plain string.
    const ops: Op[] = node.children.map((c) => ({ t: 'remove', id: c }) as Op)
    ops.push({ t: 'setProps', id, patch: { text } })
    store.apply('Edit text', ops, src(ctx))
  } else {
    store.apply('Edit text', [{ t: 'setProps', id, patch: { text } }], src(ctx))
  }
}

export interface InsertResult {
  rootIds: NodeId[]
  dropped: string[]
}

/** Parse untrusted HTML and insert it at a location, as one transaction. */
export function insertHtml(
  ctx: CommandCtx,
  html: string,
  at: NodeLocation,
  label = 'Insert',
): InsertResult {
  const { store } = ctx
  const { nodes, rootIds, dropped } = parseHtml(html, {
    isIdTaken: (id) => Boolean(store.doc.nodes[id]),
  })
  if (rootIds.length === 0) return { rootIds: [], dropped }
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
  return { rootIds, dropped }
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
