import { genId } from './ids'
import {
  COMPONENT_SET_PAD, COMPONENT_SET_PAD_TOP, componentSetStyle,
} from './instances'
import type { DocumentModel, NodeId, NodeModel, PageModel } from './types'

/**
 * Forward-only document migrations. Each step upgrades the doc in place to the
 * next schemaVersion; `migrateDocument` runs every step needed and is
 * idempotent (re-running on a current doc is a no-op).
 */

export const SCHEMA_VERSION = 2

export function migrateDocument(doc: DocumentModel): DocumentModel {
  let d = doc
  if ((d.schemaVersion ?? 1) < 2) d = migrateV1toV2(d)
  return d
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
