import {
  ALLOWED_TAGS,
  DROP_CONTENT_TAGS,
  SVG_ATTRS,
  SVG_TAGS,
  URL_ATTRS,
  isAllowedAttr,
  isAllowedCssProp,
  isSafeAttrValue,
  isSafeCssValue,
  sanitizeClasses,
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
  for (const [prop, value] of parseStyleAttr(text)) {
    if (isAllowedCssProp(prop) && isSafeCssValue(value)) out[prop] = value
    else dropped?.push(`css:${prop}`)
  }
  return out
}

const ID_RE = /^[\w-]{1,64}$/

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
      } else if (name.toLowerCase().startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        dropped.push(`attr:${name}`)
      } else if (isSvgEl) {
        if (SVG_ATTRS.has(name) && isSafeAttrValue(attr.value)) {
          node.attrs[name] = attr.value.slice(0, 4000)
        } else if (!name.startsWith('data-')) {
          dropped.push(`attr:${name}`)
        }
      } else if (URL_ATTRS.has(name)) {
        const safe = sanitizeUrl(attr.value)
        if (safe !== null) node.attrs[name] = safe
        else dropped.push(`url:${name}`)
      } else if (isAllowedAttr(name)) {
        node.attrs[name] = attr.value.slice(0, 1000)
      } else if (!name.startsWith('data-')) {
        dropped.push(`attr:${name}`)
      }
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

  return { nodes, rootIds, dropped }
}
