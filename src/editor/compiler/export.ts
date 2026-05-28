import { resolveNode } from '../model/instances'
import type { DocumentModel, NodeId } from '../model/types'
import type { ResolvedNode } from '../model/instances'

/**
 * Model -> HTML / JSX. The output is the same DOM the canvas renders
 * (instances expanded), so design and code never diverge. Stable ids and
 * layer names are emitted as data-cz-id / data-cz-name so exported markup
 * re-imports without losing identity.
 */

export interface ExportOptions {
  /** Emit data-cz-id/data-cz-name for lossless re-import. Default true. */
  ids?: boolean
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
      const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      // -webkit-foo -> WebkitFoo (leading dash leaves leading lowercase otherwise)
      out[key.startsWith('-') ? camel.slice(1).charAt(0).toUpperCase() + camel.slice(2) : camel] = value
    }
  }
  return out
}
