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
