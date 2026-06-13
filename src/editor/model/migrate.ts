import { genId } from './ids'
import {
  COMPONENT_SET_PAD, COMPONENT_SET_PAD_TOP, componentSetStyle,
} from './instances'
import type {
  CommentMessage, CommentThread, DocumentModel, NodeId, NodeModel, PageModel,
} from './types'

/**
 * Forward-only document migrations. Each step upgrades the doc in place to the
 * next schemaVersion; `migrateDocument` runs every step needed and is
 * idempotent (re-running on a current doc is a no-op).
 */

export const SCHEMA_VERSION = 2

export function migrateDocument(doc: DocumentModel): DocumentModel {
  let d = doc
  if ((d.schemaVersion ?? 1) < 2) d = migrateV1toV2(d)
  // Additive fields, no schema bump: ensure the optional flows/comments
  // collections exist so reads/writes never special-case a missing array.
  if (!d.flows) d = { ...d, flows: [] }
  d = { ...d, comments: normalizeComments(d) }
  return d
}

/**
 * Bring every comment to the current thread shape. Documents saved while the
 * first (removed) comment experiment was live persist `comments` as flat pins —
 * `{ id, nodeId, author, body, resolved }` with no `messages` array — which the
 * thread UI would crash on. Repair those (and any partial thread) into a real
 * `CommentThread`: synthesize the opening message from the legacy body, lift
 * `nodeId` into `nodeIds`, and backfill `pageId`/coordinates. Idempotent: a
 * well-formed thread passes through unchanged. Junk (non-objects) is dropped.
 */
function normalizeComments(doc: DocumentModel): CommentThread[] {
  const raw = doc.comments
  if (!Array.isArray(raw)) return []
  const fallbackPageId = doc.activePageId ?? doc.pages[0]?.id ?? ''
  const out: CommentThread[] = []
  for (const c of raw as unknown[]) {
    if (!c || typeof c !== 'object') continue
    const t = c as Record<string, unknown>
    const messages: CommentMessage[] =
      Array.isArray(t.messages) && t.messages.length > 0
        ? (t.messages as CommentMessage[])
        : [{
            id: genId('msg'),
            author: t.author === 'agent' ? 'agent' : 'user',
            body: typeof t.body === 'string' ? t.body : '',
            createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
          }]
    const nodeIds = Array.isArray(t.nodeIds)
      ? (t.nodeIds as NodeId[])
      : typeof t.nodeId === 'string'
        ? [t.nodeId]
        : []
    out.push({
      id: typeof t.id === 'string' ? t.id : genId('cmt'),
      pageId: typeof t.pageId === 'string' ? t.pageId : fallbackPageId,
      x: typeof t.x === 'number' ? t.x : 0,
      y: typeof t.y === 'number' ? t.y : 0,
      nodeIds,
      ...(t.area && typeof t.area === 'object' ? { area: t.area as CommentThread['area'] } : {}),
      messages,
      resolved: Boolean(t.resolved),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    })
  }
  return out
}

/**
 * v1 → v2: component sets become real container nodes. In v1 each variant root
 * was an independent top-level page node and the set was metadata only; here
 * each set gains a flex-column frame node (`isComponentSet`) whose children are
 * its variant roots, so variants render nested like a Figma component set.
 */
function migrateV1toV2(doc: DocumentModel): DocumentModel {
  const nodes: Record<NodeId, NodeModel> = { ...doc.nodes }
  const pages: PageModel[] = doc.pages.map((p) => ({ ...p, children: [...p.children] }))
  const componentSets = { ...doc.componentSets }

  for (const set of Object.values(doc.componentSets)) {
    if (set.nodeId && nodes[set.nodeId]) continue // already in v2 shape

    const rootIds = set.variantIds
      .map((vid) => doc.components[vid]?.rootId)
      .filter((id): id is NodeId => Boolean(id) && Boolean(nodes[id!]))
    if (rootIds.length === 0) continue

    const baseRootId = doc.components[set.defaultVariantId]?.rootId ?? rootIds[0]
    const page = pages.find((p) => p.children.includes(baseRootId))
    if (!page) continue

    const baseNode = nodes[baseRootId]
    const baseLeft = parseFloat(baseNode.style.left ?? '') || 0
    const baseTop = parseFloat(baseNode.style.top ?? '') || 0

    const setNodeId = genId('cset')
    const setNode: NodeModel = {
      id: setNodeId,
      name: set.name,
      tag: 'div',
      attrs: {},
      style: componentSetStyle(baseLeft - COMPONENT_SET_PAD, baseTop - COMPONENT_SET_PAD_TOP),
      classes: [],
      children: [...rootIds],
      parent: null,
      visible: true,
      locked: false,
      isComponentSet: true,
    }

    // Detach each variant root from its page and re-home it under the set,
    // stripping the absolute placement it owned as a page node.
    for (const rid of rootIds) {
      for (const p of pages) {
        const i = p.children.indexOf(rid)
        if (i >= 0) p.children.splice(i, 1)
      }
      const style = { ...nodes[rid].style }
      delete style.position
      delete style.left
      delete style.top
      delete style.right
      delete style.bottom
      nodes[rid] = { ...nodes[rid], parent: setNodeId, style }
    }

    nodes[setNodeId] = setNode
    page.children.push(setNodeId)
    componentSets[set.id] = { ...set, nodeId: setNodeId }
  }

  return { ...doc, schemaVersion: 2, nodes, pages, componentSets }
}
