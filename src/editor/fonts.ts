import type { DocumentModel, FontModel } from './model/types'
import type { EditorStore } from './store/editorStore'

/**
 * Font manager. Document fonts (doc.fonts) sync to <link> stylesheets from
 * Google Fonts — the only allowed remote origin, with validated family names
 * so nothing else can be smuggled into the URL. System fonts load nothing.
 */

const GOOGLE_CSS = 'https://fonts.googleapis.com/css2'
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,59}$/
const LINK_ATTR = 'data-cz-font'

export const DEFAULT_WEIGHTS = [400, 500, 600, 700]

/**
 * Families installed on the host OS (the app runs on macOS). These resolve
 * from local glyphs with no network load, so they register as `source: 'system'`
 * rather than being routed to Google Fonts. Matching is case-insensitive.
 */
export const SYSTEM_FONTS = [
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  'SF Pro', 'SF Pro Display', 'SF Pro Text', 'SF Pro Rounded', 'SF Compact',
  'SF Mono', 'New York', 'Menlo', 'Monaco',
  'Helvetica', 'Helvetica Neue', 'Arial', 'Avenir', 'Avenir Next',
  'Times', 'Times New Roman', 'Georgia', 'Courier', 'Courier New',
  'Geneva', 'Verdana',
]

const SYSTEM_FONT_SET = new Set(SYSTEM_FONTS.map((f) => f.toLowerCase()))

export function isSystemFont(family: string): boolean {
  return SYSTEM_FONT_SET.has(family.trim().toLowerCase())
}

export function isValidFamily(family: string): boolean {
  return FAMILY_RE.test(family.trim())
}

export function fontHref(font: FontModel): string {
  const family = font.family.trim().replace(/ /g, '+')
  const weights = [...new Set(font.weights)]
    .filter((w) => w >= 100 && w <= 1000)
    .sort((a, b) => a - b)
    .join(';')
  return `${GOOGLE_CSS}?family=${family}:wght@${weights || '400'}&display=swap`
}

/** Reconcile <link data-cz-font> tags in <head> with the document's fonts. */
export function syncDocumentFonts(doc: DocumentModel) {
  if (typeof document === 'undefined') return
  const wanted = new Map<string, string>()
  for (const font of Object.values(doc.fonts ?? {})) {
    if (font.source === 'google' && isValidFamily(font.family)) {
      wanted.set(font.family, fontHref(font))
    }
  }
  const existing = document.head.querySelectorAll<HTMLLinkElement>(`link[${LINK_ATTR}]`)
  for (const link of existing) {
    const family = link.getAttribute(LINK_ATTR) ?? ''
    const href = wanted.get(family)
    if (!href) link.remove()
    else if (link.href !== href) link.href = href
    if (href) wanted.delete(family)
  }
  for (const [family, href] of wanted) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.setAttribute(LINK_ATTR, family)
    document.head.appendChild(link)
  }
}

/** Keep stylesheets in sync with the store for the app's lifetime. */
export function startFontSync(store: EditorStore): () => void {
  syncDocumentFonts(store.doc)
  return store.subscribeDoc(() => syncDocumentFonts(store.doc))
}

/** Whether the browser actually has glyphs for the family (post-load). */
export async function verifyFontLoaded(family: string, timeoutMs = 4000): Promise<boolean> {
  if (typeof document === 'undefined' || !isValidFamily(family)) return false
  try {
    await Promise.race([
      document.fonts.load(`16px "${family.trim()}"`),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
    return document.fonts.check(`16px "${family.trim()}"`)
  } catch {
    return false
  }
}
