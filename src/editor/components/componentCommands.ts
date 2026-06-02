import { genId } from '../model/ids'
import { parsePathId, resolveNode } from '../model/instances'
import { px, fmtPx } from '../canvas/geometry'
import { locate } from '../commands'
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

export function createMainComponent(ctx: Ctx, selection: string[]): string | null {
  const { store } = ctx
  if (selection.length !== 1) return null
  const id = parsePathId(selection[0]).sourceId
  const node = store.doc.nodes[id]
  if (!node || node.componentId || node.isComponentRoot || node.isArtboard) return null

  const componentId = genId('cmp')
  store.apply('Create component', [
    { t: 'setProps', id, patch: { isComponentRoot: true } },
    { t: 'defineComponent', def: { id: componentId, name: node.name, rootId: id } },
  ], src(ctx))
  return componentId
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

  const instance: NodeModel = {
    id: genId('inst'),
    name: def.name,
    tag: defRoot.tag,
    attrs: {},
    style: {
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
export function createVariant(
  ctx: Ctx,
  componentId: string,
  variantName: string,
): string | null {
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
  return variantId
}

/** Replace an instance with plain nodes (what it currently renders as). */
