/**
 * Shared copy buffer. Canvas keyboard shortcuts and layer-tree context menus
 * read/write the same payload (sanitized HTML produced by copyNodes), and
 * mirror it to the system clipboard for cross-document pastes.
 */
export const clipboard = { html: '' }

export function setClipboard(html: string) {
  clipboard.html = html
  void navigator.clipboard?.writeText(html).catch(() => {})
}
