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

function attrsOf(node: ResolvedNode, opts: ExportOptions): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  if (opts.ids !== false) {
    pairs.push(['data-cz-id', node.sourceId])
    pairs.push(['data-cz-name', node.name])
  }
  if (node.classes.length > 0) pairs.push(['class', node.classes.join(' ')])
  const style = { ...node.style }
  if (!node.visible) style.display = 'none'
  if (Object.keys(style).length > 0) pairs.push(['style', styleToString(style)])
  for (const [k, v] of Object.entries(node.attrs)) pairs.push([k, v])
  return pairs
}

export function resolvedToHtml(node: ResolvedNode, opts: ExportOptions = {}, depth = 0): string {
  const indent = opts.indent ?? '  '
  const pad = indent.repeat(depth)
  const attrs = attrsOf(node, opts)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('')
  const open = `${pad}<${node.tag}${attrs}>`
  if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrs} />`
  if (node.children.length === 0) {
    return `${open}${escapeHtml(node.text ?? '')}</${node.tag}>`
  }
  const children = node.children.map((c) => resolvedToHtml(c, opts, depth + 1)).join('\n')
  return `${open}\n${children}\n${pad}</${node.tag}>`
}

export function exportHtml(doc: DocumentModel, rootId: NodeId, opts: ExportOptions = {}): string {
  const resolved = resolveNode(doc, rootId)
  if (!resolved) throw new Error(`Unknown node: ${rootId}`)
  return resolvedToHtml(resolved, opts)
}
