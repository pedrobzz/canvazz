import { assetIdsInValue, resolveAssetRef, resolveImgSrc } from './assets'
import { resolveNode } from '../model/instances'
import { fontHref } from '../fonts'
import type { DocumentModel, NodeId } from '../model/types'
import type { ResolvedNode } from '../model/instances'

/**
 * Model -> HTML / JSX. The output is the same DOM the canvas renders
 * (instances expanded for HTML; re-folded into real React components for JSX),
 * so design and code never diverge. Imported assets, referenced by the short
 * `asset://<id>` handle, resolve to their bytes once at export — deduped behind
 * a CSS custom property for backgrounds, inlined for <img src>.
 */

export interface ExportOptions {
  /**
   * Emit data-cz-id/data-cz-name for lossless re-import. Defaults to true for
   * HTML (re-import relies on it); JSX strips them unless opted in (they are
   * noise in a production component).
   */
  ids?: boolean
  /** Wrap the fragment in a full HTML document (fonts, tokens, Tailwind). */
  standalone?: boolean
  indent?: string
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input'])

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function styleToString(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

/** kebab-case CSS -> React style object keys (custom props pass through). */
export function styleToReact(style: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(style)) {
    if (key.startsWith('--')) {
      out[key] = value
    } else {
      // -webkit-line-clamp -> WebkitLineClamp; border-top -> borderTop
      out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value
    }
  }
  return out
}

/** Apply a transform to each style value, returning a fresh record (order kept). */
function mapStyleValues(
  style: Record<string, string>,
  fn: (value: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(style)) out[k] = fn(v)
  return out
}

const ASSET_URL_RE = /url\(\s*["']?(asset:\/\/[A-Za-z0-9_-]+)["']?\s*\)/g

// --- Assets ----------------------------------------------------------------

/** Custom-property name backing a deduped asset url() in exported CSS. */
function assetVar(id: string): string {
  return `--cz-asset-${id}`
}

/**
 * Collects every asset used in the exported subtree so it is emitted once on
 * the root as `--cz-asset-<id>: url(data:…)`; background url()s reference it via
 * var(), so N reuses inline the bytes once.
 */
class AssetCollector {
  private readonly defs = new Map<string, string>()

  constructor(private readonly doc: DocumentModel) {}

  /** Rewrite `url(asset://id)` -> `url(var(--cz-asset-id))`, recording the def. */
  style(value: string): string {
    if (!value.includes('asset://')) return value
    for (const id of assetIdsInValue(value)) {
      const url = this.doc.assets?.[id]?.url
      if (url) this.defs.set(assetVar(id), `url("${url}")`)
    }
    return value.replace(ASSET_URL_RE, (whole, ref: string) => {
      const id = ref.slice('asset://'.length)
      return this.doc.assets?.[id]?.url ? `url(var(${assetVar(id)}))` : whole
    })
  }

  /** Resolve an <img src> handle to its data URL (inline; no shared layer). */
  imgSrc(value: string): string {
    return resolveImgSrc(this.doc, value)
  }

  /** Custom-prop definitions for every asset referenced, for the root style. */
  rootVars(): Record<string, string> {
    return Object.fromEntries(this.defs)
  }
}

// --- HTML ------------------------------------------------------------------

interface HtmlCtx {
  opts: ExportOptions
  assets: AssetCollector
  /** Extra custom properties to fold into the root element's style. */
  rootVars: Record<string, string>
}

function htmlAttrs(node: ResolvedNode, ctx: HtmlCtx, isRoot: boolean): string {
  const pairs: Array<[string, string]> = []
  if (ctx.opts.ids !== false) {
    pairs.push(['data-cz-id', node.sourceId])
    pairs.push(['data-cz-name', node.name])
  }
  if (node.classes.length > 0) pairs.push(['class', node.classes.join(' ')])
  const resolved = mapStyleValues(node.style, (v) => ctx.assets.style(v))
  const style = isRoot ? { ...ctx.rootVars, ...resolved } : resolved
  if (!node.visible) style.display = 'none'
  if (Object.keys(style).length > 0) pairs.push(['style', styleToString(style)])
  for (const [k, v] of Object.entries(node.attrs)) {
    pairs.push([k, k === 'src' ? ctx.assets.imgSrc(v) : v])
  }
  return pairs.map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('')
}

function resolvedToHtmlCtx(node: ResolvedNode, ctx: HtmlCtx, depth: number, isRoot: boolean): string {
  const indent = ctx.opts.indent ?? '  '
  const pad = indent.repeat(depth)
  const attrs = htmlAttrs(node, ctx, isRoot)
  if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrs} />`
  if (node.children.length === 0) {
    return `${pad}<${node.tag}${attrs}>${escapeHtml(node.text ?? '')}</${node.tag}>`
  }
  const children = node.children.map((c) => resolvedToHtmlCtx(c, ctx, depth + 1, false)).join('\n')
  return `${pad}<${node.tag}${attrs}>\n${children}\n${pad}</${node.tag}>`
}

/** Back-compat single-node HTML render (no doc context, so no asset dedup). */
export function resolvedToHtml(node: ResolvedNode, opts: ExportOptions = {}, depth = 0): string {
  const empty = { assets: {}, tokens: {} } as unknown as DocumentModel
  const ctx: HtmlCtx = { opts, assets: new AssetCollector(empty), rootVars: {} }
  return resolvedToHtmlCtx(node, ctx, depth, true)
}

/** Token custom properties for the export root, so var(--token) resolves. */
function tokenVars(doc: DocumentModel): Record<string, string> {
  return Object.fromEntries(
    Object.entries(doc.tokens).map(([k, v]) => [k.startsWith('--') ? k : `--${k}`, v]),
  )
}

export function exportHtml(doc: DocumentModel, rootId: NodeId, opts: ExportOptions = {}): string {
  const resolved = resolveNode(doc, rootId)
  if (!resolved) throw new Error(`Unknown node: ${rootId}`)
  const assets = new AssetCollector(doc)
  // Tokens always defined on the root; asset vars are appended after render
  // (the collector only knows which assets are used once the body is walked).
  const baseDepth = opts.standalone ? 1 : 0
  // Pre-render children so the collector fills, then build the root tag with
  // both token and asset vars. Single recursion keeps order; root gets vars.
  const ctx: HtmlCtx = { opts, assets, rootVars: {} }
  const childHtml = resolved.children.map((c) => resolvedToHtmlCtx(c, ctx, baseDepth + 1, false))
  // Collect any assets used by the root's own style too, before snapshotting
  // the custom-prop block onto it (an asset can be referenced only at the root).
  for (const v of Object.values(resolved.style)) assets.style(v)
  ctx.rootVars = { ...tokenVars(doc), ...assets.rootVars() }
  const fragment = renderRoot(resolved, ctx, baseDepth, childHtml)
  return opts.standalone ? wrapStandaloneHtml(doc, fragment) : fragment
}

/** Emit the root element with its pre-rendered children and hoisted vars. */
function renderRoot(root: ResolvedNode, ctx: HtmlCtx, depth: number, childHtml: string[]): string {
  const indent = ctx.opts.indent ?? '  '
  const pad = indent.repeat(depth)
  const attrs = htmlAttrs(root, ctx, true)
  if (VOID_TAGS.has(root.tag)) return `${pad}<${root.tag}${attrs} />`
  if (root.children.length === 0) {
    return `${pad}<${root.tag}${attrs}>${escapeHtml(root.text ?? '')}</${root.tag}>`
  }
  return `${pad}<${root.tag}${attrs}>\n${childHtml.join('\n')}\n${pad}</${root.tag}>`
}

// --- Standalone document ---------------------------------------------------

/** Runtime Tailwind engine — the same v4 browser build the canvas loads. */
const TAILWIND_CDN = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4'

function wrapStandaloneHtml(doc: DocumentModel, body: string): string {
  const head: string[] = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(doc.name || 'Untitled')}</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com" />',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
  ]
  // Google-source document fonts; system fonts load nothing remote.
  for (const font of Object.values(doc.fonts ?? {})) {
    if (font.source === 'google') {
      head.push(`<link rel="stylesheet" href="${escapeHtml(fontHref(font))}" />`)
    }
  }
  // Document tokens as :root custom properties, so var(--token) resolves.
  const tokenEntries = Object.entries(doc.tokens)
  if (tokenEntries.length > 0) {
    const decls = tokenEntries
      .map(([k, v]) => `      ${k.startsWith('--') ? k : `--${k}`}: ${v};`)
      .join('\n')
    head.push(`<style>\n    :root {\n${decls}\n    }\n  </style>`)
  }
  // Runtime Tailwind: compiles the utility classes present in the body on load.
  head.push(`<script src="${TAILWIND_CDN}"></script>`)
  const headHtml = head.map((line) => `  ${line}`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
${headHtml}
</head>
<body>
${body}
</body>
</html>
`
}

// --- JSX -------------------------------------------------------------------

/**
 * HTML attribute -> React/JSX prop. Covers the names React renames plus the
 * standard SVG presentation set (React only accepts them camelCased) and the
 * xlink/xml edge cases, so exported components compile under the React preset.
 */
const JSX_ATTR_MAP: Record<string, string> = {
  class: 'className', for: 'htmlFor', colspan: 'colSpan', rowspan: 'rowSpan',
  maxlength: 'maxLength', readonly: 'readOnly', tabindex: 'tabIndex',
  srcset: 'srcSet', autocomplete: 'autoComplete', contenteditable: 'contentEditable',
  crossorigin: 'crossOrigin', autofocus: 'autoFocus', enctype: 'encType',
  novalidate: 'noValidate', formaction: 'formAction', spellcheck: 'spellCheck',
  // SVG presentation attributes React knows only in camelCase.
  'fill-opacity': 'fillOpacity', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
  'clip-path': 'clipPath', 'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset', 'stroke-opacity': 'strokeOpacity',
  'stroke-miterlimit': 'strokeMiterlimit',
  'color-interpolation-filters': 'colorInterpolationFilters',
  'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity', 'flood-color': 'floodColor',
  'flood-opacity': 'floodOpacity', 'vector-effect': 'vectorEffect', 'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline', 'letter-spacing': 'letterSpacing',
  'font-size': 'fontSize', 'font-family': 'fontFamily', 'font-weight': 'fontWeight',
  'transform-origin': 'transformOrigin', 'paint-order': 'paintOrder',
  // xlink (deprecated namespace) and common xml: attrs -> camelCase.
  'xlink:href': 'xlinkHref', 'xlink:title': 'xlinkTitle', 'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
}

/**
 * The JSX prop for an HTML attribute. `data-*`/`aria-*` stay kebab-case (React
 * renders them verbatim); everything else consults the rename map.
 */
function jsxProp(name: string): string {
  if (name.startsWith('data-') || name.startsWith('aria-')) return name
  return JSX_ATTR_MAP[name] ?? name
}

function jsxStyleLiteral(style: Record<string, string>): string {
  const entries = Object.entries(styleToReact(style)).map(([k, v]) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`
    return `${key}: '${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  })
  return `{{ ${entries.join(', ')} }}`
}

/** Resolve every `url(asset://id)` in a value to `url("data:…")` inline. */
function inlineAssetUrls(doc: DocumentModel, value: string): string {
  if (!value.includes('asset://')) return value
  return value.replace(ASSET_URL_RE, (whole, ref: string) => {
    const url = resolveAssetRef(doc, ref)
    return url ? `url("${url}")` : whole
  })
}

function escapeJsxText(text: string): string {
  return escapeHtml(text).replaceAll('{', '&#123;').replaceAll('}', '&#125;')
}

interface JsxCtx {
  doc: DocumentModel
  opts: ExportOptions
  /** Component functions to emit, keyed by their PascalCase name. */
  components: Map<string, string>
}

/**
 * Emit a node as JSX. A component instance (componentId set) below the root
 * renders as `<ComponentName … />` and registers its function in ctx.components;
 * everything else is plain markup. data-cz-* is stripped unless opts.ids.
 */
function resolvedToJsx(node: ResolvedNode, ctx: JsxCtx, depth: number): string {
  if (node.componentId && depth > 0) return emitInstanceElement(node, ctx, depth)
  return emitPlainJsx(node, ctx, depth, node.style)
}

/** Plain element markup. `styleOverride` lets the root inject token vars. */
function emitPlainJsx(
  node: ResolvedNode,
  ctx: JsxCtx,
  depth: number,
  styleSource: Record<string, string>,
): string {
  const indent = ctx.opts.indent ?? '  '
  const pad = indent.repeat(depth)
  const parts: string[] = []
  if (ctx.opts.ids === true) {
    parts.push(`data-cz-id="${escapeHtml(node.sourceId)}"`)
    parts.push(`data-cz-name="${escapeHtml(node.name)}"`)
  }
  if (node.classes.length > 0) parts.push(`className="${escapeHtml(node.classes.join(' '))}"`)
  const style = mapStyleValues(styleSource, (v) => inlineAssetUrls(ctx.doc, v))
  if (!node.visible) style.display = 'none'
  if (Object.keys(style).length > 0) parts.push(`style=${jsxStyleLiteral(style)}`)
  for (const [k, v] of Object.entries(node.attrs)) {
    const value = k === 'src' ? resolveImgSrc(ctx.doc, v) : v
    parts.push(`${jsxProp(k)}="${escapeHtml(value)}"`)
  }
  const attrs = parts.length > 0 ? ' ' + parts.join(' ') : ''
  if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrs} />`
  if (node.children.length === 0) {
    const text = node.text ? escapeJsxText(node.text) : ''
    return text
      ? `${pad}<${node.tag}${attrs}>${text}</${node.tag}>`
      : `${pad}<${node.tag}${attrs} />`
  }
  const children = node.children.map((c) => resolvedToJsx(c, ctx, depth + 1)).join('\n')
  return `${pad}<${node.tag}${attrs}>\n${children}\n${pad}</${node.tag}>`
}

// --- JSX component emission ------------------------------------------------

/**
 * Render an instance as `<ComponentName style=… text=… />`. The component's
 * function is generated once from its definition; per-instance differences
 * (placement style, swapped classes, text overrides) surface as props.
 */
function emitInstanceElement(node: ResolvedNode, ctx: JsxCtx, depth: number): string {
  const indent = ctx.opts.indent ?? '  '
  const pad = indent.repeat(depth)
  const compName = ensureComponent(node, ctx)
  const def = node.componentId ? ctx.doc.components[node.componentId] : undefined
  const defRoot = def ? resolveNode(ctx.doc, def.rootId) : null
  const props: string[] = []
  // The instance root's own placement (style differing from the def) rides the
  // element; the rest lives inside the component function.
  const placement = diffStyle(defRoot?.style ?? {}, node.style)
  const style = mapStyleValues(placement, (v) => inlineAssetUrls(ctx.doc, v))
  if (!node.visible) style.display = 'none'
  if (Object.keys(style).length > 0) props.push(`style=${jsxStyleLiteral(style)}`)
  const defClasses = defRoot?.classes.join(' ') ?? ''
  if (node.classes.length > 0 && node.classes.join(' ') !== defClasses) {
    props.push(`className="${escapeHtml(node.classes.join(' '))}"`)
  }
  for (const [propName, value] of textProps(node, defRoot)) {
    props.push(`${propName}="${escapeHtml(value)}"`)
  }
  const attrs = props.length > 0 ? ' ' + props.join(' ') : ''
  return `${pad}<${compName}${attrs} />`
}

/** Register (once) and return the PascalCase name for an instance's component. */
function ensureComponent(node: ResolvedNode, ctx: JsxCtx): string {
  const def = node.componentId ? ctx.doc.components[node.componentId] : undefined
  const compName = pascalCase(def?.name ?? node.name) || 'Component'
  if (ctx.components.has(compName)) return compName
  // Reserve the name before recursing so a self-referential def can't loop.
  ctx.components.set(compName, '')
  const defRoot = def ? resolveNode(ctx.doc, def.rootId) : null
  const root = defRoot ?? node
  // Strip the def root's placement (the instance element supplies it) and
  // render its subtree as plain markup; nested instances still fold to <X/>.
  const body = emitPlainJsx(
    { ...root, componentId: undefined },
    ctx,
    2,
    stripPlacementStyle(root.style),
  )
  ctx.components.set(compName, `function ${compName}() {\n  return (\n${body}\n  )\n}`)
  return compName
}

const PLACEMENT = ['position', 'left', 'top', 'right', 'bottom', 'translate']

function stripPlacementStyle(style: Record<string, string>): Record<string, string> {
  const out = { ...style }
  for (const p of PLACEMENT) delete out[p]
  return out
}

/** Style entries in `override` whose value differs from (or is new vs) `base`. */
function diffStyle(
  base: Record<string, string>,
  override: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(override)) {
    if (base[k] !== v) out[k] = v
  }
  return out
}

/** Leaf text nodes inside a subtree, in document order. */
function collectTextSlots(node: ResolvedNode): ResolvedNode[] {
  const out: ResolvedNode[] = []
  const walk = (n: ResolvedNode) => {
    if (n.children.length === 0 && n.text !== undefined) out.push(n)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** Instance text overrides that differ from the definition, as prop pairs. */
function textProps(node: ResolvedNode, defRoot: ResolvedNode | null): Array<[string, string]> {
  if (!defRoot) return []
  const defSlots = collectTextSlots(defRoot)
  const instSlots = collectTextSlots(node)
  const out: Array<[string, string]> = []
  for (let i = 0; i < Math.min(defSlots.length, instSlots.length); i++) {
    const inst = instSlots[i]
    if (inst.text !== undefined && inst.text !== defSlots[i].text) {
      out.push([propNameFor(defSlots[i].name, i), inst.text])
    }
  }
  return out
}

function propNameFor(name: string, index: number): string {
  const camel = camelCase(name)
  return /^[a-z][\w$]*$/.test(camel) ? camel : `text${index}`
}

function pascalCase(name: string): string {
  const cleaned = name.replace(/[^\w]+(\w)?/g, (_, c: string) => (c ? c.toUpperCase() : ''))
  const ascii = cleaned.replace(/[^A-Za-z0-9]/g, '')
  return ascii.charAt(0).toUpperCase() + ascii.slice(1)
}

function camelCase(name: string): string {
  const pascal = pascalCase(name)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

export function exportJsx(doc: DocumentModel, rootId: NodeId, opts: ExportOptions = {}): string {
  const base = resolveNode(doc, rootId)
  if (!base) throw new Error(`Unknown node: ${rootId}`)
  const ctx: JsxCtx = { doc, opts, components: new Map() }
  // Token custom properties ride the exported root's style so var()s resolve.
  const rootStyle = { ...tokenVars(doc), ...base.style }
  const rootName = pascalCase(base.name) || 'Component'
  // Render the root as plain markup so its instance children fold into <X/>
  // (an instance *at* the root expands inline — there is no element above it).
  const rootBody = emitPlainJsx({ ...base, componentId: undefined }, ctx, 2, rootStyle)
  const componentFns = [...ctx.components.values()].filter(Boolean)
  const fns = componentFns.length > 0 ? componentFns.join('\n\n') + '\n\n' : ''
  return `${fns}export function ${rootName}() {\n  return (\n${rootBody}\n  )\n}\n`
}
