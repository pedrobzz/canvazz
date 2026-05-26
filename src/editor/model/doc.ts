import type {
  DocumentModel,
  NodeId,
  NodeLocation,
  NodeModel,
  NodeOverride,
  NodePropsPatch,
  Op,
  PageModel,
} from './types'

/**
 * Pure transactional core. `applyOps` never mutates the input document: it
 * shallow-clones the document and copies each node at most once per
 * transaction, so unchanged nodes keep referential identity (React renderers
 * and per-node subscriptions rely on this).
 */

export interface ApplyResult {
  doc: DocumentModel
  /** Inverse ops in application-reverse order: apply as-is to undo. */
  inverse: Op[]
  changed: NodeId[]
}

class Draft {
  doc: DocumentModel
  private touchedNodes = new Set<NodeId>()
  private clonedPages = false
  readonly changed = new Set<NodeId>()

  constructor(base: DocumentModel) {
    this.doc = { ...base, nodes: { ...base.nodes } }
  }

  node(id: NodeId): NodeModel {
    const existing = this.doc.nodes[id]
    if (!existing) throw new Error(`Unknown node: ${id}`)
    if (this.touchedNodes.has(id)) return existing
    const clone: NodeModel = {
      ...existing,
      attrs: { ...existing.attrs },
      style: { ...existing.style },
      classes: [...existing.classes],
      children: [...existing.children],
      overrides: existing.overrides
        ? Object.fromEntries(Object.entries(existing.overrides).map(([k, v]) => [k, { ...v }]))
        : undefined,
    }
    this.doc.nodes[id] = clone
    this.touchedNodes.add(id)
    this.changed.add(id)
    return clone
  }

  peek(id: NodeId): NodeModel {
    const n = this.doc.nodes[id]
    if (!n) throw new Error(`Unknown node: ${id}`)
    return n
  }

  pages(): PageModel[] {
    if (!this.clonedPages) {
      this.doc.pages = this.doc.pages.map((p) => ({ ...p, children: [...p.children] }))
      this.clonedPages = true
    }
    return this.doc.pages
  }

  page(id: string): PageModel {
    const page = this.pages().find((p) => p.id === id)
    if (!page) throw new Error(`Unknown page: ${id}`)
    return page
  }

  /** Children array a location refers to, cloned and safe to mutate. */
  container(loc: NodeLocation): NodeId[] {
    return loc.kind === 'page' ? this.page(loc.pageId).children : this.node(loc.parent).children
  }

  locate(id: NodeId): NodeLocation {
    const node = this.peek(id)
    if (node.parent) {
      const index = this.peek(node.parent).children.indexOf(id)
      if (index < 0) throw new Error(`Node ${id} missing from parent ${node.parent}`)
      return { kind: 'node', parent: node.parent, index }
    }
    for (const page of this.doc.pages) {
      const index = page.children.indexOf(id)
      if (index >= 0) return { kind: 'page', pageId: page.id, index }
    }
    throw new Error(`Node ${id} not attached to any page`)
  }
}
