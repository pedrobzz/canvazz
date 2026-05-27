import {
  ALLOWED_TAGS,
  DROP_CONTENT_TAGS,
  URL_ATTRS,
  isAllowedAttr,
  isAllowedCssProp,
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
