import { genId } from '../model/ids'
import { canonicalSourceId, parsePathId, resolveNode } from '../model/instances'
import { px, fmtPx } from '../canvas/geometry'
import { isLayoutContainer, locate } from '../commands'
import { sanitizeStyle } from '../compiler/parse'
import { sanitizeClasses } from '../compiler/allowlist'
import type { ResolvedNode } from '../model/instances'
import type { EditorStore } from '../store/editorStore'
import type {
  NodeId, NodeLocation, NodeModel, NodeOverride, Op, TransactionSource,
} from '../model/types'

/**
 * Component system commands. Main components are flagged subtrees living on
 * the canvas; instances reference them and re-render from the definition, so
 * a component edit propagates to every instance immediately. Overrides are
 * keyed by definition node id and survive component updates.
 */

interface Ctx {
  store: EditorStore
  source?: TransactionSource
}

const src = (ctx: Ctx) => ctx.source ?? 'user'

/** All main components live on this dedicated, freely editable page. */
export const DESIGN_SYSTEM_PAGE_ID = 'page_design_system'

/**
 * Create a main component: the subtree MOVES to the Design System page
 * (created on demand) and a linked instance takes its place, so the original
 * layout is visually unchanged while every main lives in one place.
 */
export interface CreateComponentResult {
  componentId: string
  /** The linked instance left in the original location. */
  instanceId: NodeId
  /** The main definition's root (moved to the Design System page). */
  rootId: NodeId
}

export function createMainComponent(ctx: Ctx, selection: string[]): CreateComponentResult | null {
  const { store } = ctx
  if (selection.length !== 1) return null
  const id = parsePathId(selection[0]).sourceId
  const node = store.doc.nodes[id]
  if (!node || node.componentId || node.isComponentRoot || node.isArtboard) return null
  const loc = locate(store, id)
  if (!loc) return null

  const componentId = genId('cmp')
  const wasFlow = node.style.position !== 'absolute'
  const ops: Op[] = []

  const dsPage = store.doc.pages.find((p) => p.id === DESIGN_SYSTEM_PAGE_ID)
  const dsChildren = dsPage?.children ?? []
  if (!dsPage) {
    ops.push({
      t: 'addPage',
      page: { id: DESIGN_SYSTEM_PAGE_ID, name: 'Design System', children: [] },
      index: store.doc.pages.length,
    })
  }
  // Stack mains vertically with breathing room.
  let nextY = 60
  for (const childId of dsChildren) {
    const child = store.doc.nodes[childId]
    const top = px(child?.style.top ?? '') ?? 0
    const height = px(child?.style.height ?? '') ?? 120
    nextY = Math.max(nextY, top + height + 60)
  }

  // The replacement instance mirrors the original's layout participation.
  const instance: NodeModel = {
    id: genId('inst'),
    name: node.name,
    tag: node.tag,
    attrs: {},
    style: wasFlow
      ? {}
      : {
          position: 'absolute',
          left: node.style.left ?? '0px',
          top: node.style.top ?? '0px',
        },
    classes: [],
    children: [],
    parent: null,
    visible: true,
    locked: false,
    componentId,
  }

  ops.push(
    { t: 'setProps', id, patch: { isComponentRoot: true } },
    { t: 'defineComponent', def: { id: componentId, name: node.name, rootId: id } },
    { t: 'move', id, to: { kind: 'page', pageId: DESIGN_SYSTEM_PAGE_ID, index: dsChildren.length } },
    { t: 'setStyle', id, set: { position: 'absolute', left: '60px', top: fmtPx(nextY) } },
    { t: 'insertTree', nodes: [instance], rootId: instance.id, at: loc },
  )
  store.apply('Create component', ops, src(ctx))
  store.setSelection([instance.id])
  store.recordSelectionAfter()
  return { componentId, instanceId: instance.id, rootId: id }
}

export function createInstance(
  ctx: Ctx,
  componentId: string,
  at: NodeLocation,
  position: { x: number; y: number },
): NodeId | null {
  const { store } = ctx
  const def = store.doc.components[componentId]
  const defRoot = def ? store.doc.nodes[def.rootId] : null
  if (!def || !defRoot) return null

  // Instances join the flow inside auto-layout containers; elsewhere they
  // place absolutely at the requested position.
  const parentNode = at.kind === 'node' ? store.doc.nodes[at.parent] : null
  const flow = parentNode ? isLayoutContainer(parentNode) : false
  const instance: NodeModel = {
    id: genId('inst'),
    name: def.name,
    tag: defRoot.tag,
    attrs: {},
    style: flow
      ? {}
      : {
          position: 'absolute',
          left: fmtPx(position.x),
          top: fmtPx(position.y),
          ...(defRoot.style.width ? { width: defRoot.style.width } : {}),
          ...(defRoot.style.height ? { height: defRoot.style.height } : {}),
        },
    classes: [],
    children: [],
    parent: null,
    visible: true,
    locked: false,
    componentId,
  }
  store.apply(`Insert ${def.name}`, [
    { t: 'insertTree', nodes: [instance], rootId: instance.id, at },
  ], src(ctx))
  return instance.id
}

/**
 * Add a variant to a component: clones the definition subtree next to the
 * original and groups both into a component set.
 */
export interface CreateVariantResult {
  variantId: string
  rootId: NodeId
  /** Base-definition node id -> this variant's cloned node id. */
  idMap: Record<NodeId, NodeId>
}

export function createVariant(
  ctx: Ctx,
  componentId: string,
  variantName: string,
): CreateVariantResult | null {
  const { store } = ctx
  const def = store.doc.components[componentId]
  const defRoot = def ? store.doc.nodes[def.rootId] : null
  if (!def || !defRoot) return null

  // Clone definition subtree with fresh ids, offset right of the original.
  const cloneIds = new Map<NodeId, NodeId>()
  const cloned: NodeModel[] = []
  const walk = (id: NodeId, parent: NodeId | null): NodeId => {
    const orig = store.doc.nodes[id]
    const newId = genId()
    cloneIds.set(id, newId)
    const copy: NodeModel = {
      ...orig,
      id: newId,
      // Overrides stay keyed by the base definition's ids across variants.
      refId: orig.refId ?? id,
      parent,
      attrs: { ...orig.attrs },
      style: { ...orig.style },
      classes: [...orig.classes],
      children: [],
    }
    cloned.push(copy)
    copy.children = orig.children.map((c) => walk(c, newId))
    return newId
  }
  const newRootId = walk(def.rootId, defRoot.parent)
  const newRoot = cloned.find((n) => n.id === newRootId)
  if (!newRoot) return null
  const left = px(defRoot.style.left)
  const width = px(defRoot.style.width) ?? 100
  if (left !== null) newRoot.style.left = fmtPx(left + width + 40)
  newRoot.name = `${def.name} / ${variantName}`

  const loc = locate(store, def.rootId)
  if (!loc) return null

  const variantId = genId('cmp')
  const setId = def.setId ?? genId('set')
  const existingSet = def.setId ? store.doc.componentSets[def.setId] : null
  const baseVariantProps = def.variantProps ?? { variant: 'default' }

  const ops: Op[] = [
    { t: 'insertTree', nodes: cloned, rootId: newRootId, at: { ...loc, index: loc.index + 1 } },
    {
      t: 'defineComponent',
      def: { id: variantId, name: newRoot.name, rootId: newRootId, setId, variantProps: { variant: variantName } },
    },
  ]
  if (!existingSet) {
    ops.push(
      { t: 'defineComponent', def: { ...def, setId, variantProps: baseVariantProps } },
      {
        t: 'defineComponentSet',
        set: { id: setId, name: def.name, variantIds: [componentId, variantId], defaultVariantId: componentId },
      },
    )
  } else {
    ops.push({
      t: 'defineComponentSet',
      set: { ...existingSet, variantIds: [...existingSet.variantIds, variantId] },
    })
  }
  store.apply(`Add variant ${variantName}`, ops, src(ctx))
  return { variantId, rootId: newRootId, idMap: Object.fromEntries(cloneIds) }
}

/**
 * Delete a component definition (or one variant). The definition subtree is
 * removed from the Design System page. Refuses while instances still depend
 * on it; instances merely *switched* to a deleted variant fall back to base.
 */
export function deleteComponent(ctx: Ctx, componentId: string): { ok: true } | { ok: false; reason: string } {
  const { store } = ctx
  const def = store.doc.components[componentId]
  if (!def) return { ok: false, reason: `Unknown component: ${componentId}` }

  const set = def.setId ? store.doc.componentSets[def.setId] : null
  const isBaseWithVariants =
    set && set.variantIds.length > 1 && (set.defaultVariantId === componentId || set.variantIds[0] === componentId)
  if (isBaseWithVariants) {
    return { ok: false, reason: 'Delete the other variants first — this is the base definition of a set.' }
  }
  const dependents = Object.values(store.doc.nodes).filter((n) => n.componentId === componentId)
  if (dependents.length > 0) {
    return { ok: false, reason: `${dependents.length} instance(s) still use this component — detach or delete them first.` }
  }

  const ops: Op[] = []
  // Instances pointing at this as a *variant* fall back to their base.
  for (const n of Object.values(store.doc.nodes)) {
    if (n.variantId === componentId) ops.push({ t: 'setProps', id: n.id, patch: { variantId: null } })
  }
  if (store.doc.nodes[def.rootId]) ops.push({ t: 'remove', id: def.rootId })
  ops.push({ t: 'removeComponent', id: componentId })
  if (set) {
    ops.push({
      t: 'defineComponentSet',
      set: { ...set, variantIds: set.variantIds.filter((v) => v !== componentId) },
    })
  }
  store.apply(`Delete component ${def.name}`, ops, src(ctx))
  return { ok: true }
}

/** Replace an instance with plain nodes (what it currently renders as). */
export function detachInstance(ctx: Ctx, instanceId: NodeId): NodeId | null {
  const { store } = ctx
  const instance = store.doc.nodes[instanceId]
  if (!instance?.componentId) return null
  const resolved = resolveNode(store.doc, instanceId)
  const loc = locate(store, instanceId)
  if (!resolved || !loc) return null

  const nodes: NodeModel[] = []
  const build = (r: ResolvedNode, parent: NodeId | null): NodeId => {
    const id = genId()
    const node: NodeModel = {
      id,
      name: r.name,
      tag: r.tag,
      attrs: { ...r.attrs },
      style: { ...r.style },
      classes: [...r.classes],
      text: r.text,
      children: [],
      parent,
      visible: r.visible,
      locked: false,
    }
    nodes.push(node)
    node.children = r.children.map((c) => build(c, id))
    return id
  }
  const rootId = build(resolved, instance.parent)

  store.apply('Detach instance', [
    { t: 'remove', id: instanceId },
    { t: 'insertTree', nodes, rootId, at: loc },
  ], src(ctx))
  store.setSelection([rootId])
  store.recordSelectionAfter()
  return rootId
}

/** Sanitized override write (text/style/classes/attrs/visible/swap). */
export function setInstanceOverride(
  ctx: Ctx,
  instanceId: NodeId,
  sourceId: NodeId,
  patch: NodeOverride | null,
): boolean {
  const { store } = ctx
  const instance = store.doc.nodes[instanceId]
  if (!instance?.componentId) return false
  // Writes use the canonical (base-definition) key so they apply to every variant.
  sourceId = canonicalSourceId(store.doc, sourceId)
  let safe: NodeOverride | null = null
  if (patch) {
    safe = { ...patch }
    if (safe.style) {
      safe.style = sanitizeStyle(
        Object.entries(safe.style).map(([k, v]) => `${k}: ${v}`).join('; '),
      )
    }
    if (safe.classes) safe.classes = sanitizeClasses(safe.classes)
    if (safe.componentId && !store.doc.components[safe.componentId]) return false
    if (safe.variantId && !store.doc.components[safe.variantId]) return false
  }
  store.apply('Override instance', [
    { t: 'setOverride', id: instanceId, sourceId, patch: safe },
  ], src(ctx))
  return true
}

export function setInstanceVariant(ctx: Ctx, instanceId: NodeId, variantId: string): boolean {
  const { store } = ctx
  const instance = store.doc.nodes[instanceId]
  if (!instance?.componentId || !store.doc.components[variantId]) return false
  store.apply('Switch variant', [
    { t: 'setProps', id: instanceId, patch: { variantId } },
  ], src(ctx))
  return true
}

/** Variants available for an instance's component, if it belongs to a set. */
export function variantsOf(store: EditorStore, componentId: string) {
  const def = store.doc.components[componentId]
  const set = def?.setId ? store.doc.componentSets[def.setId] : null
  if (!set) return []
  return set.variantIds
    .map((id) => store.doc.components[id])
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
}
