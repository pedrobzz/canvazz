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
  'form', 'noscript', 'template', 'svg', 'math', 'video', 'audio', 'canvas',
  'frame', 'frameset', 'applet',
])

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

/** Allows safe absolute URLs, relative paths, fragments, and data images. */
export function sanitizeUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./')) return trimmed
  try {
    const url = new URL(trimmed)
    return SAFE_URL_PROTOCOLS.has(url.protocol) ? trimmed : null
  } catch {
    // Bare relative path without scheme.
    return /^[\w][\w\-./?=&%#+ ]*$/.test(trimmed) ? trimmed : null
  }
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
  'outline', 'outline-offset', 'outline-width', 'outline-style', 'outline-color',
  'box-shadow', 'opacity', 'mix-blend-mode', 'isolation',
  'color', 'accent-color', 'caret-color',
  // Typography
  'font', 'font-family', 'font-size', 'font-weight', 'font-style',
  'font-variant', 'font-stretch', 'line-height', 'letter-spacing',
  'word-spacing', 'text-align', 'text-decoration', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness',
  'text-transform', 'text-overflow', 'text-shadow', 'text-indent', 'text-wrap',
  'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'vertical-align',
  'list-style', 'list-style-type', 'list-style-position', '-webkit-line-clamp',
  '-webkit-box-orient', '-webkit-background-clip', '-webkit-text-fill-color',
  // Effects / geometry
  'transform', 'transform-origin', 'rotate', 'scale', 'translate',
  'filter', 'backdrop-filter', 'clip-path', 'mask-image',
  'object-fit', 'object-position', 'cursor', 'pointer-events',
  'visibility', 'user-select', 'transition', 'will-change',
  'contain', 'content-visibility', 'container-type',
])

/** Value-level rejects: expressions and external loads inside CSS values. */
const FORBIDDEN_VALUE = /(expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import|url\s*\(\s*(?!['"]?\s*(?:data:image\/|#|\/(?!\/)|\.\/|https:)))/i

export function isSafeCssValue(value: string): boolean {
  if (value.length > 2000) return false
  if (FORBIDDEN_VALUE.test(value)) return false
  // Block control characters and angle brackets; allow normal CSS punctuation.
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F<>]/.test(value)
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
