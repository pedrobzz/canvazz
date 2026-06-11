import type { DocumentModel, NodeId, NodeModel, NodeOverride } from './types'

/**
 * Component instance expansion. Instances store only { componentId,
 * variantId, overrides }; their rendered subtree is derived from the main
 * component definition every time, so component edits propagate instantly
 * while valid overrides survive (they are keyed by source node id).
 *
 * Resolved nodes carry a `pathId` (`instanceId:sourceId` for internals) used
 * as data-node-id in the DOM, so internals are selectable and overridable.
 */

export interface ResolvedNode {
  /** DOM identity: node id, or `${instanceId}:${sourceId}` inside instances. */
  pathId: string
  /** Model node carrying the base values (instance node or def node). */
  sourceId: NodeId
  /** Nearest enclosing instance node id, null outside instances. */
  instanceId: NodeId | null
  name: string
  tag: string
  attrs: Record<string, string>
  style: Record<string, string>
  classes: string[]
  text?: string
  visible: boolean
  locked: boolean
  isArtboard?: boolean
  isComponentRoot?: boolean
  componentId?: string
  children: ResolvedNode[]
}

export function parsePathId(pathId: string): { instanceId: NodeId | null; sourceId: NodeId } {
  const idx = pathId.indexOf(':')
  if (idx < 0) return { instanceId: null, sourceId: pathId }
  return { instanceId: pathId.slice(0, idx), sourceId: pathId.slice(idx + 1) }
}

const PLACEMENT_PROPS = ['position', 'left', 'top', 'right', 'bottom', 'translate'] as const

/**
 * Main components live absolutely positioned on the Design System page;
 * instances must never inherit that placement — they own their own.
 */
export function stripPlacement(style: Record<string, string>): Record<string, string> {
  const out = { ...style }
  for (const prop of PLACEMENT_PROPS) delete out[prop]
  return out
}

export function effectiveComponentRoot(doc: DocumentModel, node: NodeModel): NodeId | null {
  if (!node.componentId) return null
  const defId = node.variantId ?? node.componentId
  const def = doc.components[defId] ?? doc.components[node.componentId]
  return def ? def.rootId : null
}

export function applyOverride(
  base: NodeModel,
  override: NodeOverride | undefined,
): Pick<ResolvedNode, 'attrs' | 'style' | 'classes' | 'text' | 'visible'> {
  if (!override) {
    return { attrs: base.attrs, style: base.style, classes: base.classes, text: base.text, visible: base.visible }
  }
  return {
    attrs: override.attrs ? { ...base.attrs, ...override.attrs } : base.attrs,
    style: override.style ? { ...base.style, ...override.style } : base.style,
    classes: override.classes ?? base.classes,
    text: override.text ?? base.text,
    visible: override.visible ?? base.visible,
  }
}

/**
 * Resolve a node (and its subtree) to render-ready form. Pure; used by
 * export, screenshots, and MCP reads. The canvas renderer mirrors this logic
 * with per-node React subscriptions.
 */
export function resolveNode(
  doc: DocumentModel,
  id: NodeId,
  seenComponents: ReadonlySet<string> = new Set(),
): ResolvedNode | null {
  const node = doc.nodes[id]
  if (!node) return null

  if (node.componentId) {
    return resolveInstance(doc, node, seenComponents)
  }

  return {
    pathId: node.id,
    sourceId: node.id,
    instanceId: null,
    name: node.name,
    tag: node.tag,
    attrs: node.attrs,
    style: node.style,
    classes: node.classes,
    text: node.text,
    visible: node.visible,
    locked: node.locked,
    isArtboard: node.isArtboard,
    isComponentRoot: node.isComponentRoot,
    children: node.children
      .map((c) => resolveNode(doc, c, seenComponents))
      .filter((c): c is ResolvedNode => c !== null),
  }
}

function resolveInstance(
  doc: DocumentModel,
  instance: NodeModel,
  seenComponents: ReadonlySet<string>,
): ResolvedNode | null {
  const rootId = effectiveComponentRoot(doc, instance)
  const defId = instance.variantId ?? instance.componentId
  if (!rootId || !defId || seenComponents.has(defId)) return null
  const defRoot = doc.nodes[rootId]
  if (!defRoot) return null
  const seen = new Set(seenComponents).add(defId)

  const walkDef = (defNode: NodeModel, isRoot: boolean): ResolvedNode | null => {
    const override = instance.overrides?.[defNode.id]

    // Nested instance swap: override.componentId re-targets a nested instance.
    if (defNode.componentId && !isRoot) {
      const swapped: NodeModel = override?.componentId
        ? { ...defNode, componentId: override.componentId, variantId: override.variantId }
        : override?.variantId
          ? { ...defNode, variantId: override.variantId }
          : defNode
      const resolved = resolveInstance(doc, swapped, seen)
      if (!resolved) return null
      return { ...resolved, pathId: `${instance.id}:${defNode.id}`, instanceId: instance.id }
    }

    const merged = applyOverride(defNode, override)
    if (isRoot) {
      // The instance node controls placement: its own style/classes win over
      // the def root's, so instances can be moved/resized independently.
      merged.style = { ...stripPlacement(merged.style), ...instance.style }
      merged.classes = instance.classes.length > 0 ? instance.classes : merged.classes
      merged.visible = instance.visible
      if (instance.text !== undefined) merged.text = instance.text
    }
    return {
      pathId: isRoot ? instance.id : `${instance.id}:${defNode.id}`,
      sourceId: isRoot ? instance.id : defNode.id,
      instanceId: instance.id,
      name: isRoot ? instance.name : defNode.name,
      tag: defNode.tag,
      locked: instance.locked,
      componentId: isRoot ? defId : undefined,
      ...merged,
      children: defNode.children
        .map((c) => {
          const child = doc.nodes[c]
          return child ? walkDef(child, false) : null
        })
        .filter((c): c is ResolvedNode => c !== null),
    }
  }

  return walkDef(defRoot, true)
}
