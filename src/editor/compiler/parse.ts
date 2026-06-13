import {
  ALLOWED_TAGS,
  DROP_CONTENT_TAGS,
  SVG_ATTRS,
  SVG_TAGS,
  URL_ATTRS,
  classifyUrl,
  cssValuePolicyReject,
  isAllowedAttr,
  isAllowedCssProp,
  isSafeAttrValue,
  isSafeCssValue,
  sanitizeClasses,
  sanitizeCssUrls,
  sanitizeUrl,
} from './allowlist'
import { genId } from '../model/ids'
import type { NodeModel } from '../model/types'

/**
 * HTML/CSS/Tailwind -> sanitized model. The input is untrusted (AI output,
 * pasted markup, imports). Everything passes the allowlists; scripts, event
 * handlers, javascript: URLs, iframes, and unsupported CSS are stripped and
 * reported in `dropped` so callers (and the AI) can see what was rejected.
 *
 * Stable ids and layer names round-trip via data-cz-id / data-cz-name.
 */

export interface ParseResult {
  nodes: NodeModel[]
  rootIds: string[]
  dropped: string[]
  /**
   * Non-fatal notices: input that was KEPT but the caller should know about,
   * e.g. an external `<img src>` that makes the canvas depend on the network.
   * Optional/additive so downstream callers can ignore it safely.
   */
  warnings?: string[]
}

export interface ParseOptions {
  /** Reject data-cz-id values that collide with existing ids. */
  isIdTaken?: (id: string) => boolean
  /** Default position style applied to root nodes lacking one. */
  defaultRootStyle?: Record<string, string>
}

/** Split a style attribute into declarations, respecting url(...) and quotes. */
export function parseStyleAttr(text: string): Array<[string, string]> {
  const decls: Array<[string, string]> = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  const flush = () => {
    const idx = cur.indexOf(':')
    if (idx > 0) {
      const prop = cur.slice(0, idx).trim().toLowerCase()
      const value = cur.slice(idx + 1).trim()
      if (prop && value) decls.push([prop, value])
    }
    cur = ''
  }
  for (const ch of text) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ';' && depth === 0) flush()
    else cur += ch
  }
  flush()
  return decls
}

export function sanitizeStyle(
  text: string,
  dropped?: string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [prop, rawValue] of parseStyleAttr(text)) {
    if (!isAllowedCssProp(prop)) {
      dropped?.push(`css:${prop}`)
      continue
    }
    // Hard security check on the RAW value first: catches javascript:/
    // expression()/@import/control chars even when buried inside a url(), so
    // the url stripper can never mangle a payload into something that slips by.
    if (!isSafeCssValue(rawValue)) {
      dropped?.push(`css:${prop}`)
      continue
    }
    // Layout-model policy (position: fixed/sticky) — reject with a clear reason
    // so it never silently applies.
    if (cssValuePolicyReject(prop, rawValue)) {
      dropped?.push(`css:${prop} (disallowed value)`)
      continue
    }
    // One url() policy for every url-bearing declaration (shorthand and
    // longhand alike): keep data:/asset://#frag/relative, strip external
    // http(s) and anything unsafe, and report each removed reference.
    const { value, dropped: urlDropped } = sanitizeCssUrls(rawValue)
    for (const cls of urlDropped) dropped?.push(`css:${prop} url(${cls})`)
    // An empty value after stripping every url() means the declaration carried
    // nothing but external refs — drop it rather than emit `prop: `.
    if (value === '') {
      if (urlDropped.length === 0) dropped?.push(`css:${prop}`)
      continue
    }
    out[prop] = value
  }
  return out
}

const ID_RE = /^[\w-]{1,64}$/

/**
 * SVG presentation attributes that are also CSS properties. When such an
 * attribute carries a `var(--token)`, CSS custom properties do NOT resolve in
 * the *attribute* form (they paint nothing), but they resolve naturally when
 * moved into inline `style`. We relocate only var()-bearing values here; plain
 * literals (`stroke="#f00"`) stay as attributes so the model is unchanged.
 */
const SVG_PRESENTATION_CSS_ATTRS = new Set([
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity', 'stroke-opacity',
  'fill-rule', 'clip-rule', 'opacity', 'stop-color', 'stop-opacity',
  'color', 'paint-order', 'vector-effect',
  'font-size', 'font-family', 'font-weight', 'letter-spacing',
  'text-anchor', 'dominant-baseline',
])

const VAR_RE = /var\s*\(/i

const TAG_NAMES: Record<string, string> = {
  svg: 'Vector', path: 'Path', circle: 'Circle', rect: 'Rect', line: 'Line',
  ellipse: 'Ellipse', polygon: 'Polygon', polyline: 'Polyline', g: 'Group',
  p: 'Text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4',
  h5: 'Heading 5', h6: 'Heading 6', span: 'Text', img: 'Image', button: 'Button',
  a: 'Link', ul: 'List', ol: 'List', li: 'List item', input: 'Input',
  textarea: 'Textarea', select: 'Select', section: 'Section', header: 'Header',
  footer: 'Footer', nav: 'Nav', main: 'Main', article: 'Article', aside: 'Aside',
  table: 'Table', hr: 'Divider', blockquote: 'Quote', pre: 'Code block', code: 'Code',
  label: 'Label', figure: 'Figure', figcaption: 'Caption',
}

function defaultName(tag: string, text?: string): string {
  if (text) {
    const trimmed = text.trim().replace(/\s+/g, ' ')
    if (trimmed) return trimmed.slice(0, 24)
  }
  return TAG_NAMES[tag] ?? 'Frame'
}

/**
 * Parse an untrusted HTML fragment into model nodes. Requires a DOM
 * implementation (browser or jsdom/happy-dom in tests).
 */
export function parseHtml(html: string, opts: ParseOptions = {}): ParseResult {
  const dropped: string[] = []
  const warnings: string[] = []
  const nodes: NodeModel[] = []
  const usedIds = new Set<string>()

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

  const takeId = (el: Element): string => {
    const raw = el.getAttribute('data-cz-id')
    if (
      raw &&
      ID_RE.test(raw) &&
      !usedIds.has(raw) &&
      !(opts.isIdTaken?.(raw) ?? false)
    ) {
      usedIds.add(raw)
      return raw
    }
    const id = genId()
    usedIds.add(id)
    return id
  }

  const convertElement = (el: Element, parentId: string | null, inSvg: boolean): NodeModel | null => {
    // localName keeps DOM-adjusted SVG casing (linearGradient) and is
    // lowercase for HTML elements.
    const tag = el.localName
    const isSvgEl = inSvg || tag === 'svg'
    if (isSvgEl) {
      // Inside svg content only the sanctioned subset survives; unknown
      // elements (use, foreignObject, filter, animate…) drop wholesale.
      if (!SVG_TAGS.has(tag)) {
        dropped.push(`tag:${tag}`)
        return null
      }
    } else if (DROP_CONTENT_TAGS.has(tag)) {
      dropped.push(`tag:${tag}`)
      return null
    }

    const node: NodeModel = {
      id: takeId(el),
      name: '',
      tag: isSvgEl || ALLOWED_TAGS.has(tag) ? tag : 'div',
      attrs: {},
      style: {},
      classes: [],
      children: [],
      parent: parentId,
      visible: true,
      locked: false,
    }
    if (!isSvgEl && !ALLOWED_TAGS.has(tag)) dropped.push(`tag:${tag}->div`)

    // SVG presentation attrs carrying var() are relocated to inline style so
    // tokens resolve; collected here and merged after the loop (inline style,
    // if also present, wins).
    const relocatedStyle: Record<string, string> = {}

    for (const attr of Array.from(el.attributes)) {
      // SVG attribute names are case-sensitive (viewBox); HTML's lowercase.
      const name = isSvgEl ? attr.name : attr.name.toLowerCase()
      if (name === 'style') {
        node.style = sanitizeStyle(attr.value, dropped)
      } else if (name === 'class') {
        const classes = sanitizeClasses(attr.value)
        if (classes.length < attr.value.split(/\s+/).filter(Boolean).length) dropped.push('class:partial')
        node.classes = classes
      } else if (name === 'data-cz-name') {
        node.name = attr.value.slice(0, 80)
      } else if (name === 'data-cz-id') {
        // consumed by takeId
      } else if (name === 'data-cz-icon' || name === 'data-cz-variant') {
        // Annotation linking a vector back to its SF Symbol, for the inspector.
        node.attrs[name] = attr.value.slice(0, 80)
      } else if (name.toLowerCase().startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        dropped.push(`attr:${name}`)
      } else if (isSvgEl) {
        if (SVG_ATTRS.has(name) && isSafeAttrValue(attr.value)) {
          // var() does not resolve in SVG presentation *attributes* (paints
          // nothing). Relocate token-bearing presentation values to inline
          // style, where custom properties resolve and live-update. Literals
          // stay as attributes so the model is otherwise untouched.
          if (SVG_PRESENTATION_CSS_ATTRS.has(name) && VAR_RE.test(attr.value)) {
            relocatedStyle[name] = attr.value.slice(0, 4000)
          } else {
            node.attrs[name] = attr.value.slice(0, 4000)
          }
        } else if (!name.startsWith('data-')) {
          dropped.push(`attr:${name}`)
        }
      } else if (URL_ATTRS.has(name)) {
        const safe = sanitizeUrl(attr.value)
        if (safe !== null) {
          node.attrs[name] = safe
          // External <img src> is kept (placeholders are a legit agent flow)
          // but the canvas now depends on the network — surface it so agents
          // can switch to a real asset. href to external sites is normal; no
          // warning there.
          if (name === 'src' && classifyUrl(safe) === 'external') {
            warnings.push(
              `img src kept: external url (${safe}) — canvas now depends on the network; prefer import_asset`,
            )
          }
        } else dropped.push(`url:${name}`)
      } else if (isAllowedAttr(name)) {
        node.attrs[name] = attr.value.slice(0, 1000)
      } else if (!name.startsWith('data-')) {
        dropped.push(`attr:${name}`)
      }
    }

    // Fold relocated var() presentation values into inline style. An explicit
    // inline `style` declaration for the same property wins (author intent).
    if (Object.keys(relocatedStyle).length > 0) {
      node.style = { ...relocatedStyle, ...node.style }
    }

    nodes.push(node)

    // Children: elements and meaningful text. Mixed content normalizes loose
    // text runs into spans (visually identical; keeps text-or-children model).
    const childEls: NodeModel[] = []
    let textOnly = ''
    let hasElementChild = false
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) hasElementChild = true
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? ''
        if (!hasElementChild) {
          textOnly += text
        } else if (text.trim()) {
          const span: NodeModel = {
            id: genId(), name: defaultName('span', text), tag: 'span',
            attrs: {}, style: {}, classes: [], children: [], parent: node.id,
            visible: true, locked: false, text: text.replace(/\s+/g, ' '),
          }
          nodes.push(span)
          childEls.push(span)
        }
      } else if (child.nodeType === 1) {
        const converted = convertElement(child as Element, node.id, isSvgEl)
        if (converted) childEls.push(converted)
      }
    }

    if (!hasElementChild) {
      const text = textOnly.replace(/\s+/g, ' ').trim()
      if (text) node.text = text
    }
    node.children = childEls.map((c) => c.id)
    if (!node.name) node.name = defaultName(node.tag, node.text)
    return node
  }

  const rootIds: string[] = []
  for (const el of Array.from(doc.body.children)) {
    const node = convertElement(el, null, false)
    if (node) {
      if (opts.defaultRootStyle && !node.style.position) {
        node.style = { ...opts.defaultRootStyle, ...node.style }
      }
      rootIds.push(node.id)
    }
  }

  return warnings.length > 0
    ? { nodes, rootIds, dropped, warnings }
    : { nodes, rootIds, dropped }
}
