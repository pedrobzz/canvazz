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
