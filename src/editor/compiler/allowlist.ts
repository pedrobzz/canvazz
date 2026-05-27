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
