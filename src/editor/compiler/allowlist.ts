/**
 * Single source of truth for what HTML/CSS is allowed in the document model.
 * All input (user paste, AI writes, imports) is validated against these
 * allowlists. Anything not listed is stripped, never errored on render.
 */

export const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'header', 'footer', 'nav', 'main', 'article', 'aside',
  'figure', 'figcaption', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
  'img', 'button', 'label', 'input', 'textarea', 'select', 'option',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'hr', 'br',
])

/** Tags whose content is dropped wholesale, not unwrapped. */
export const DROP_CONTENT_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'noscript', 'template', 'math', 'video', 'audio', 'canvas',
  'frame', 'frameset', 'applet',
])

/**
 * Sanitized SVG subset — vectors are DOM elements too. No scripting hooks,
 * no external references: `use`, `foreignObject`, `image`, `animate*`,
 * `filter`, `pattern` are dropped wholesale inside svg content.
 */
export const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'text', 'tspan',
])

/** SVG presentation/geometry attributes (case-sensitive, DOM-adjusted names). */
export const SVG_ATTRS = new Set([
  'd', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule',
  'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'points', 'width', 'height', 'transform', 'transform-origin',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
  'gradientTransform', 'spreadMethod', 'preserveAspectRatio', 'xmlns', 'id',
  'vector-effect', 'pathLength', 'text-anchor', 'dominant-baseline',
  'font-size', 'font-family', 'font-weight', 'letter-spacing',
])

/**
 * Attribute values may reference same-document ids (`url(#grad)`) but never
 * external resources or script.
 */
export function isSafeAttrValue(value: string): boolean {
  if (value.length > 4000) return false
  if (/javascript:|data:text|<|>/i.test(value)) return false
  const urls = value.match(/url\s*\(\s*['"]?[^'")]*/gi)
  if (urls) return urls.every((u) => /url\s*\(\s*['"]?#/i.test(u))
  return true
}

export const ALLOWED_ATTRS = new Set([
  'src', 'alt', 'href', 'title', 'placeholder', 'type', 'value', 'name',
  'width', 'height', 'loading', 'role', 'lang', 'dir', 'target', 'rel',
  'disabled', 'checked', 'readonly', 'maxlength', 'rows', 'cols', 'for',
  'colspan', 'rowspan',
])

/** aria-* attributes are allowed; data-* are reserved for the editor. */
export function isAllowedAttr(name: string): boolean {
  const lower = name.toLowerCase()
  return ALLOWED_ATTRS.has(lower) || lower.startsWith('aria-')
}

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** Inline data images the canvas can render without a network round-trip. */
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,/i
/** Local asset reference resolved by the asset pipeline (asset://<id>). */
const ASSET_RE = /^asset:\/\/[\w-]+/i

/**
 * One url() policy for the whole sanitizer. Every place that accepts a URL —
 * `<img src>`, `<a href>`, and every url(...) inside a CSS value — classifies
 * through here so the rules never drift between shorthand and longhand.
 *
 * - `data:` images and `asset://<id>` refs are SAFE (no network dependency).
 * - same-document `#fragment` refs (e.g. url(#grad)) are SAFE.
 * - relative paths are SAFE.
 * - external http(s) URLs are EXTERNAL (the canvas would depend on the network):
 *   callers strip them from CSS and keep-with-warning on <img src>.
 * - anything else (javascript:, data:text, vbscript:, …) is UNSAFE.
 */
export type UrlClass = 'safe' | 'external' | 'unsafe'

export function classifyUrl(value: string): UrlClass {
  const trimmed = value.trim()
  if (trimmed === '') return 'unsafe'
  if (DATA_IMAGE_RE.test(trimmed) || ASSET_RE.test(trimmed)) return 'safe'
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./')) return 'safe'
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'external'
    return SAFE_URL_PROTOCOLS.has(url.protocol) ? 'safe' : 'unsafe'
  } catch {
    // Bare relative path without scheme.
    return /^[\w][\w\-./?=&%#+ ]*$/.test(trimmed) ? 'safe' : 'unsafe'
  }
}

/** Allows safe absolute URLs, relative paths, fragments, data images, assets. */
export function sanitizeUrl(value: string): string | null {
  const cls = classifyUrl(value)
  // External http(s) is allowed for <img src> placeholders; the parser warns.
  return cls === 'unsafe' ? null : value.trim()
}

export const URL_ATTRS = new Set(['src', 'href'])

/**
 * Allowed CSS properties (kebab-case). Covers layout, flex/grid, box model,
 * paint, typography, and effects — everything the inspector edits plus what
 * well-formed AI output needs. Shorthands are kept as authored to preserve
 * round-trip fidelity.
 */
export const ALLOWED_CSS_PROPS = new Set([
  // Box / position
  'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-sizing', 'aspect-ratio', 'overflow', 'overflow-x', 'overflow-y',
  // Logical box properties (writing-mode aware equivalents of the above)
  'padding-inline', 'padding-block', 'padding-inline-start', 'padding-inline-end',
  'padding-block-start', 'padding-block-end',
  'margin-inline', 'margin-block', 'margin-inline-start', 'margin-inline-end',
  'margin-block-start', 'margin-block-end',
  'inset-inline', 'inset-block', 'inset-inline-start', 'inset-inline-end',
  'inset-block-start', 'inset-block-end',
  'inline-size', 'block-size', 'min-inline-size', 'min-block-size',
  'max-inline-size', 'max-block-size',
  // Flex / grid
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow',
  'flex-shrink', 'flex-basis', 'order', 'gap', 'row-gap', 'column-gap',
  'justify-content', 'justify-items', 'justify-self',
  'align-items', 'align-content', 'align-self', 'place-items', 'place-content',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column', 'grid-row', 'grid-area',
  // Paint
  'background', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'background-clip',
  'background-attachment', 'background-origin', 'background-blend-mode',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-image', 'border-image-source', 'border-image-slice',
  'border-image-width', 'border-image-outset', 'border-image-repeat',
  'outline', 'outline-offset', 'outline-width', 'outline-style', 'outline-color',
  'box-shadow', 'opacity', 'mix-blend-mode', 'isolation',
  'color', 'accent-color', 'caret-color',
  // Typography
  'font', 'font-family', 'font-size', 'font-weight', 'font-style',
  'font-variant', 'font-variant-numeric', 'font-variant-ligatures',
  'font-variant-caps', 'font-feature-settings', 'font-kerning',
  'font-synthesis', '-webkit-font-smoothing', '-moz-osx-font-smoothing',
  'font-stretch', 'line-height', 'letter-spacing',
  'word-spacing', 'text-align', 'text-decoration', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness',
  'text-transform', 'text-overflow', 'text-shadow', 'text-indent', 'text-wrap',
  'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'vertical-align',
  'list-style', 'list-style-type', 'list-style-position', 'list-style-image',
  '-webkit-line-clamp',
  '-webkit-box-orient', '-webkit-background-clip', '-webkit-text-fill-color',
  // SVG presentation
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity', 'stroke-opacity',
  'stop-color', 'stop-opacity', 'paint-order', 'vector-effect',
  // Effects / geometry
  'transform', 'transform-origin', 'rotate', 'scale', 'translate',
  'filter', 'backdrop-filter', 'clip-path', 'mask-image',
  'object-fit', 'object-position', 'cursor', 'pointer-events',
  'visibility', 'user-select', 'transition', 'will-change',
  'contain', 'content-visibility', 'container-type',
])

/** Value-level rejects: expressions and CSS-engine escapes. url() is handled
 * separately by classifyUrl (see sanitizeCssUrls) so the policy stays uniform. */
const FORBIDDEN_VALUE = /(expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import)/i

export function isSafeCssValue(value: string): boolean {
  if (value.length > 2000) return false
  if (FORBIDDEN_VALUE.test(value)) return false
  // Block control characters and angle brackets; allow normal CSS punctuation.
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F<>]/.test(value)
}

/** Matches each url(...) token in a CSS value, capturing the inner reference. */
const CSS_URL_RE = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi

/**
 * Strip url() references the canvas must not load. Every url-bearing CSS
 * property funnels through here — `background` shorthand, `background-image`,
 * `mask-image`, `border-image`, `list-style-image`, etc. — so there is no gap
 * between shorthand and longhand. `data:`/`asset://`/`#frag`/relative refs are
 * kept verbatim; external http(s) and anything unsafe are removed and reported
 * (`external` vs `unsafe`) for the caller's `dropped` list.
 */
export function sanitizeCssUrls(value: string): { value: string; dropped: UrlClass[] } {
  const dropped: UrlClass[] = []
  const out = value.replace(CSS_URL_RE, (match, _q: string, ref: string) => {
    const cls = classifyUrl(ref)
    if (cls === 'safe') return match
    dropped.push(cls)
    return ''
  })
  // Collapse leftover whitespace from a removed token inside a shorthand.
  return { value: out.replace(/\s{2,}/g, ' ').trim(), dropped }
}

/**
 * Property/value pairs that pass the allowlists but break the canvas layout
 * model. `position: fixed | sticky` would escape the artboard's containing
 * block, so they are rejected everywhere (parse-time + update_styles); agents
 * are told to use `absolute`. Returns a reason when the pair is disallowed.
 */
export function cssValuePolicyReject(prop: string, value: string): string | null {
  if (prop.toLowerCase().trim() === 'position') {
    const v = value.trim().toLowerCase()
    if (v === 'fixed' || v === 'sticky') return 'disallowed value — use absolute'
  }
  return null
}

export function isAllowedCssProp(prop: string): boolean {
  const lower = prop.toLowerCase().trim()
  return ALLOWED_CSS_PROPS.has(lower) || lower.startsWith('--')
}

/** Tailwind class tokens: conservative charset, no arbitrary-value escapes that could smuggle url(). */
const CLASS_TOKEN = /^[\w!:@<>/.\-[\]()%#,&*]+$/
const CLASS_FORBIDDEN = /(javascript:|url\((?!['"]?(data:image\/|#|https:)))/i

export function sanitizeClasses(input: string | string[]): string[] {
  const tokens = Array.isArray(input) ? input : input.split(/\s+/)
  return tokens.filter((t) => t.length > 0 && t.length <= 200 && CLASS_TOKEN.test(t) && !CLASS_FORBIDDEN.test(t))
}
