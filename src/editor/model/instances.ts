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
