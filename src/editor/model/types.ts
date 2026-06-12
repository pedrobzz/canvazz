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
  /**
   * Marks the container node of a component set: its children are the variant
   * roots (each `isComponentRoot`), laid out and rendered nested like a Figma
   * component set. Backed by ComponentSetModel.nodeId.
   */
  isComponentSet?: boolean
  /**
   * For variant-clone nodes: the id of the corresponding node in the base
   * definition. Instance overrides are keyed by this canonical id, so they
   * survive variant switches (every variant's "Name" maps to one key).
   */
  refId?: NodeId
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
  /** The container node whose children are the variant roots. */
  nodeId: NodeId
  /** Component ids that are variants of this set. */
  variantIds: string[]
  defaultVariantId: string
}

/** A loadable font family (Google Fonts or locally installed). */
export interface FontModel {
  family: string
  /** Numeric weights to load, e.g. [400, 700]. */
  weights: number[]
  source: 'google' | 'system'
}

export interface AssetModel {
  id: string
  name: string
  mime: string
  size: number
  /** data: URL or app-served URL. Stable reference used from node attrs. */
  url: string
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
  /** Fonts available to the document, keyed by family name. */
  fonts: Record<string, FontModel>
  assets: Record<string, AssetModel>
}

/** Where a node lives: under another node, or at the top level of a page. */
export type NodeLocation =
  | { kind: 'node'; parent: NodeId; index: number }
  | { kind: 'page'; pageId: string; index: number }

/**
 * Operations. Every mutation is an Op; applying an Op returns its inverse so
 * transactions are undoable by construction.
 */
export type Op =
  | { t: 'insertTree'; nodes: NodeModel[]; rootId: NodeId; at: NodeLocation }
  | { t: 'remove'; id: NodeId }
  | { t: 'move'; id: NodeId; to: NodeLocation }
  | { t: 'setProps'; id: NodeId; patch: NodePropsPatch }
  | { t: 'setStyle'; id: NodeId; set: Record<string, string | null> }
  | { t: 'setClasses'; id: NodeId; classes: string[] }
  | { t: 'setAttrs'; id: NodeId; set: Record<string, string | null> }
  | { t: 'setOverride'; id: NodeId; sourceId: NodeId; patch: NodeOverride | null }
  | { t: 'defineComponent'; def: ComponentDef }
  | { t: 'removeComponent'; id: string }
  | { t: 'defineComponentSet'; set: ComponentSetModel }
  | { t: 'setToken'; name: string; value: string | null }
  | { t: 'setFont'; family: string; font: FontModel | null }
  | { t: 'addPage'; page: PageModel; index: number }
  | { t: 'removePage'; id: string }
  | { t: 'setPageName'; id: string; name: string }
  | { t: 'addAsset'; asset: AssetModel }

export interface NodePropsPatch {
  name?: string
  tag?: string
  text?: string | null
  visible?: boolean
  locked?: boolean
  isArtboard?: boolean
  isComponentRoot?: boolean
  isComponentSet?: boolean
  componentId?: string | null
  variantId?: string | null
}

export type TransactionSource = 'user' | 'ai' | 'system'

export interface Transaction {
  id: string
  label: string
  source: TransactionSource
  ops: Op[]
  /** Inverse ops in reverse order; applying them undoes the transaction. */
  inverse: Op[]
  /** Node ids touched, for AI result reporting and change indicators. */
  changed: NodeId[]
  at: number
}
