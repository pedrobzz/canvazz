/**
 * Canonical document model. The single source of truth for everything on the
 * canvas. Nodes are real HTML elements: `tag` + `attrs` + inline `style`
 * (kebab-case CSS) + Tailwind `classes`. The browser layout engine renders
 * them; geometry is derived from the live DOM, never duplicated here.
 */

export type NodeId = string

/** Patch applied to a node inside a component instance. */
export interface NodeOverride {
  text?: string
  style?: Record<string, string>
  classes?: string[]
  attrs?: Record<string, string>
  visible?: boolean
  /** Swap a nested instance to a different component. */
  componentId?: string
  variantId?: string
}

export interface NodeModel {
  id: NodeId
  /** Layer name shown in the layer tree; preserved across round trips. */
  name: string
  /** Lowercase HTML tag name, validated against the tag allowlist. */
  tag: string
  /** Sanitized attributes (src, alt, href, placeholder, ...). */
  attrs: Record<string, string>
  /** Inline CSS, kebab-case keys, validated against the CSS allowlist. */
  style: Record<string, string>
  /** Tailwind utility classes. */
  classes: string[]
  /** Text content. A node holds either text or children, not both. */
  text?: string
  children: NodeId[]
  parent: NodeId | null
  visible: boolean
  locked: boolean
  /** Top-level frame on a page that acts as a device/screen artboard. */
  isArtboard?: boolean
  /** Marks the root node of a main component definition. */
  isComponentRoot?: boolean
  /** Set on instance nodes: which component this instance renders. */
  componentId?: string
  /** Which variant of the component set, when the component belongs to one. */
  variantId?: string
  /** Instance overrides keyed by source node id inside the component def. */
  overrides?: Record<NodeId, NodeOverride>
}

export interface PageModel {
  id: string
  name: string
  /** Top-level node ids (artboards and free-floating nodes) in z-order. */
  children: NodeId[]
}

export interface ComponentDef {
  id: string
  name: string
  /** Root node of the main component subtree (lives in doc.nodes). */
  rootId: NodeId
  /** Component set this def belongs to, when it is a variant. */
  setId?: string
  /** Variant properties, e.g. { state: "hover" }. */
  variantProps?: Record<string, string>
}

export interface ComponentSetModel {
  id: string
  name: string
  /** Component ids that are variants of this set. */
  variantIds: string[]
  defaultVariantId: string
}

export interface AssetModel {
  id: string
  name: string
  mime: string
  size: number
  /** data: URL or app-served URL. Stable reference used from node attrs. */
  url: string
}

export interface CommentModel {
  id: string
  nodeId: NodeId | null
  /** World coordinates of the comment pin. */
  x: number
  y: number
  author: string
  body: string
  createdAt: number
  resolved: boolean
}

export interface DocumentModel {
  id: string
  name: string
  schemaVersion: number
  pages: PageModel[]
  activePageId: string
  nodes: Record<NodeId, NodeModel>
  components: Record<string, ComponentDef>
  componentSets: Record<string, ComponentSetModel>
  /** Design tokens exposed as CSS custom properties on the canvas root. */
  tokens: Record<string, string>
  assets: Record<string, AssetModel>
  comments: CommentModel[]
}
