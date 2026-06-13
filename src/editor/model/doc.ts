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

/**
 * The dedicated page that holds every main component definition. It is hidden
 * from normal page navigation and protected from rename/delete; it must never
 * count as a "user page" in last-page guards. Canonical home for the id so the
 * model layer can protect it without importing the component command layer.
 */
export const DESIGN_SYSTEM_PAGE_ID = 'page_design_system'

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

export function collectSubtree(doc: DocumentModel, rootId: NodeId): NodeModel[] {
  const out: NodeModel[] = []
  const walk = (id: NodeId) => {
    const node = doc.nodes[id]
    if (!node) throw new Error(`Unknown node: ${id}`)
    out.push(node)
    node.children.forEach(walk)
  }
  walk(rootId)
  return out
}

export function isAncestor(doc: DocumentModel, maybeAncestor: NodeId, id: NodeId): boolean {
  let cur = doc.nodes[id]?.parent ?? null
  while (cur) {
    if (cur === maybeAncestor) return true
    cur = doc.nodes[cur]?.parent ?? null
  }
  return false
}

function applyOp(draft: Draft, op: Op): Op {
  switch (op.t) {
    case 'insertTree': {
      for (const node of op.nodes) {
        if (draft.doc.nodes[node.id]) throw new Error(`Node already exists: ${node.id}`)
      }
      for (const node of op.nodes) {
        draft.doc.nodes[node.id] = node
        draft.changed.add(node.id)
      }
      const root = draft.node(op.rootId)
      root.parent = op.at.kind === 'page' ? null : op.at.parent
      const container = draft.container(op.at)
      container.splice(Math.max(0, Math.min(op.at.index, container.length)), 0, op.rootId)
      return { t: 'remove', id: op.rootId }
    }
    case 'remove': {
      const at = draft.locate(op.id)
      const nodes = collectSubtree(draft.doc, op.id)
      const container = draft.container(at)
      container.splice(container.indexOf(op.id), 1)
      for (const node of nodes) {
        delete draft.doc.nodes[node.id]
        draft.changed.add(node.id)
      }
      return { t: 'insertTree', nodes, rootId: op.id, at }
    }
    case 'move': {
      if (op.to.kind === 'node') {
        if (op.to.parent === op.id || isAncestor(draft.doc, op.id, op.to.parent)) {
          throw new Error(`Cannot move ${op.id} into its own subtree`)
        }
      }
      const from = draft.locate(op.id)
      const fromContainer = draft.container(from)
      fromContainer.splice(fromContainer.indexOf(op.id), 1)
      const node = draft.node(op.id)
      node.parent = op.to.kind === 'page' ? null : op.to.parent
      const toContainer = draft.container(op.to)
      toContainer.splice(Math.max(0, Math.min(op.to.index, toContainer.length)), 0, op.id)
      if (from.kind === 'node') draft.changed.add(from.parent)
      if (op.to.kind === 'node') draft.changed.add(op.to.parent)
      return { t: 'move', id: op.id, to: from }
    }
    case 'setProps': {
      const node = draft.node(op.id)
      // Generic key-by-key patch with capture of previous values for undo.
      const record = node as unknown as Record<string, unknown>
      const prev: Record<string, unknown> = {}
      for (const key of Object.keys(op.patch) as (keyof NodePropsPatch)[]) {
        prev[key] = record[key] ?? null
        const value = op.patch[key]
        if (value === null || value === undefined) delete record[key]
        else record[key] = value
      }
      return { t: 'setProps', id: op.id, patch: prev as NodePropsPatch }
    }
    case 'setStyle': {
      const node = draft.node(op.id)
      const prev: Record<string, string | null> = {}
      for (const [key, value] of Object.entries(op.set)) {
        prev[key] = node.style[key] ?? null
        if (value === null) delete node.style[key]
        else node.style[key] = value
      }
      return { t: 'setStyle', id: op.id, set: prev }
    }
    case 'setClasses': {
      const node = draft.node(op.id)
      const prev = node.classes
      node.classes = [...op.classes]
      return { t: 'setClasses', id: op.id, classes: prev }
    }
    case 'setAttrs': {
      const node = draft.node(op.id)
      const prev: Record<string, string | null> = {}
      for (const [key, value] of Object.entries(op.set)) {
        prev[key] = node.attrs[key] ?? null
        if (value === null) delete node.attrs[key]
        else node.attrs[key] = value
      }
      return { t: 'setAttrs', id: op.id, set: prev }
    }
    case 'setOverride': {
      const node = draft.node(op.id)
      const prevPatch: NodeOverride | null = node.overrides?.[op.sourceId] ?? null
      if (!node.overrides) node.overrides = {}
      if (op.patch === null) delete node.overrides[op.sourceId]
      else node.overrides[op.sourceId] = { ...node.overrides[op.sourceId], ...op.patch }
      return { t: 'setOverride', id: op.id, sourceId: op.sourceId, patch: prevPatch }
    }
    case 'defineComponent': {
      const prev = draft.doc.components[op.def.id]
      draft.doc.components = { ...draft.doc.components, [op.def.id]: op.def }
      draft.changed.add(op.def.rootId)
      return prev ? { t: 'defineComponent', def: prev } : { t: 'removeComponent', id: op.def.id }
    }
    case 'removeComponent': {
      const prev = draft.doc.components[op.id]
      if (!prev) throw new Error(`Unknown component: ${op.id}`)
      const next = { ...draft.doc.components }
      delete next[op.id]
      draft.doc.components = next
      return { t: 'defineComponent', def: prev }
    }
    case 'defineComponentSet': {
      const prev = draft.doc.componentSets[op.set.id]
      draft.doc.componentSets = { ...draft.doc.componentSets, [op.set.id]: op.set }
      return prev
        ? { t: 'defineComponentSet', set: prev }
        : // A set with no variants is inert; good enough as an inverse.
          { t: 'defineComponentSet', set: { ...op.set, variantIds: [] } }
    }
    case 'setToken': {
      const prev = draft.doc.tokens[op.name] ?? null
      const next = { ...draft.doc.tokens }
      if (op.value === null) delete next[op.name]
      else next[op.name] = op.value
      draft.doc.tokens = next
      return { t: 'setToken', name: op.name, value: prev }
    }
    case 'setFont': {
      const prev = draft.doc.fonts[op.family] ?? null
      const next = { ...draft.doc.fonts }
      if (op.font === null) delete next[op.family]
      else next[op.family] = op.font
      draft.doc.fonts = next
      return { t: 'setFont', family: op.family, font: prev }
    }
    case 'addPage': {
      const pages = draft.pages()
      pages.splice(Math.max(0, Math.min(op.index, pages.length)), 0, op.page)
      return { t: 'removePage', id: op.page.id }
    }
    case 'removePage': {
      const pages = draft.pages()
      const index = pages.findIndex((p) => p.id === op.id)
      if (index < 0) throw new Error(`Unknown page: ${op.id}`)
      const [page] = pages.splice(index, 1)
      if (page.children.length > 0) throw new Error(`Page ${op.id} is not empty`)
      if (draft.doc.activePageId === op.id) {
        // Land on a real user page, not the hidden Design System page.
        const fallback = pages.find((p) => p.id !== DESIGN_SYSTEM_PAGE_ID) ?? pages[0]
        draft.doc.activePageId = fallback?.id ?? ''
      }
      return { t: 'addPage', page, index }
    }
    case 'setPageName': {
      const page = draft.page(op.id)
      const prev = page.name
      page.name = op.name
      return { t: 'setPageName', id: op.id, name: prev }
    }
    case 'addAsset': {
      draft.doc.assets = { ...draft.doc.assets, [op.asset.id]: op.asset }
      // Assets are content-addressed blobs; undo keeps them (harmless, stable refs).
      return { t: 'addAsset', asset: op.asset }
    }
    case 'setFlow': {
      const flows = draft.doc.flows ?? []
      const index = flows.findIndex((f) => f.id === op.flow.id)
      const prev = index >= 0 ? flows[index] : null
      const next = [...flows]
      if (index >= 0) next[index] = op.flow
      else next.push(op.flow)
      draft.doc.flows = next
      return prev ? { t: 'setFlow', flow: prev } : { t: 'removeFlow', id: op.flow.id }
    }
    case 'removeFlow': {
      const flows = draft.doc.flows ?? []
      const prev = flows.find((f) => f.id === op.id)
      if (!prev) throw new Error(`Unknown flow: ${op.id}`)
      draft.doc.flows = flows.filter((f) => f.id !== op.id)
      return { t: 'setFlow', flow: prev }
    }
  }
}

/**
 * Flow links whose endpoints (from/to) intersect a just-removed set of node
 * ids — they are dangling and must be cleaned so the doc stays consistent.
 */
function danglingFlows(doc: DocumentModel, removed: ReadonlySet<NodeId>): NodeId[] {
  return (doc.flows ?? []).filter((f) => removed.has(f.fromId) || removed.has(f.toId)).map((f) => f.id)
}

export function applyOps(doc: DocumentModel, ops: Op[]): ApplyResult {
  const draft = new Draft(doc)
  const inverse: Op[] = []
  for (const op of ops) {
    const inv = applyOp(draft, op)
    inverse.push(inv)
    // Cleanup pass: a remove's inverse is an insertTree carrying the whole
    // removed subtree, so it tells us exactly which node ids vanished. Drop any
    // flow links that referenced them, folding the cleanup (and its undo) into
    // the same transaction so deleting an endpoint keeps the doc consistent.
    if (op.t === 'remove' && inv.t === 'insertTree') {
      const removed = new Set(inv.nodes.map((n) => n.id))
      for (const flowId of danglingFlows(draft.doc, removed)) {
        inverse.push(applyOp(draft, { t: 'removeFlow', id: flowId }))
      }
    }
  }
  inverse.reverse()
  return { doc: draft.doc, inverse, changed: [...draft.changed] }
}

export function emptyDocument(id: string, name: string): DocumentModel {
  const pageId = 'page_1'
  return {
    id,
    name,
    // Keep in sync with SCHEMA_VERSION in migrate.ts.
    schemaVersion: 2,
    pages: [{ id: pageId, name: 'Page 1', children: [] }],
    activePageId: pageId,
    nodes: {},
    components: {},
    componentSets: {},
    tokens: {},
    fonts: {},
    assets: {},
    flows: [],
    comments: [],
  }
}
