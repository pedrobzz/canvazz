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
