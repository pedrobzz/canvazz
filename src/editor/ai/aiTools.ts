import { toPng } from 'html-to-image'
import { cameraStore } from '../canvas/camera'
import { controllerRef } from '../canvas/CanvasRoot'
import { nodeElement } from '../canvas/geometry'
import { exportHtml, exportJsx } from '../compiler/export'
import { parseHtml, sanitizeStyle } from '../compiler/parse'
import { sanitizeClasses } from '../compiler/allowlist'
import {
  deleteNodes, duplicateNodes, insertHtml, locate, renameNode, setTextContent,
} from '../commands'
import {
  createMainComponent, createVariant, setInstanceOverride, setInstanceVariant,
} from '../components/componentCommands'
import { createArtboard } from '../model/factory'
import { editorStore } from '../store/editorStore'
import type { EditorStore } from '../store/editorStore'
import type { NodeId, NodeLocation, NodeModel, Op } from '../model/types'

/**
 * Browser-side executors for MCP tools. Every mutation goes through the
 * transactional command layer (source: 'ai'), so AI edits are undoable,
 * sanitized, logged, and highlighted on canvas exactly like user edits.
 * Results always include changed ids + compact context so the model rarely
 * needs follow-up reads.
 */

type Json = Record<string, unknown>

const store: EditorStore = editorStore
const AI = { store, source: 'ai' as const }

function world(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-canvas-world]')
}

function rectOf(pathId: string) {
  const r = controllerRef.current?.rectOf(pathId)
  if (!r) return null
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}

function summarize(id: NodeId): Json | null {
  const node = store.doc.nodes[id]
  if (!node) return null
  return {
    id: node.id,
    name: node.name,
    tag: node.tag,
    rect: rectOf(id),
    visible: node.visible,
    locked: node.locked,
    childCount: node.children.length,
    text: node.text !== undefined ? truncate(node.text, 80) : undefined,
    componentId: node.componentId,
    isArtboard: node.isArtboard || undefined,
    isComponentRoot: node.isComponentRoot || undefined,
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function mutationResult(label: string, changed: NodeId[]): Json {
  return {
    ok: true,
    label,
    changedIds: changed,
    changed: changed.map(summarize).filter(Boolean),
    undoable: true,
  }
}

function requireNode(id: NodeId): NodeModel {
  const node = store.doc.nodes[id]
  if (!node) throw new Error(`Unknown node id: ${id}. Use get_tree_summary to list valid ids.`)
  return node
}

function treeSummary(id: NodeId, depth: number, maxDepth: number): string[] {
  const node = store.doc.nodes[id]
  if (!node) return []
  const r = rectOf(id)
  const bits = [
    `${'  '.repeat(depth)}${node.id} "${node.name}" <${node.tag}>`,
    r ? `${r.width}×${r.height} @(${r.x},${r.y})` : '',
    node.componentId ? `instance:${node.componentId}` : '',
    node.isComponentRoot ? 'COMPONENT' : '',
    !node.visible ? 'hidden' : '',
    node.locked ? 'locked' : '',
    node.text !== undefined ? `"${truncate(node.text, 40)}"` : '',
  ].filter(Boolean)
  const line = bits.join(' ')
  if (depth >= maxDepth || node.children.length === 0) {
    return node.children.length > 0 ? [`${line} (+${node.children.length} children)`] : [line]
  }
  return [line, ...node.children.flatMap((c) => treeSummary(c, depth + 1, maxDepth))]
}

/** Resolve "insert into X" to a NodeLocation. */
function locationFor(parentId: string | undefined, index?: number): NodeLocation {
  if (parentId) {
    const parent = requireNode(parentId)
    return { kind: 'node', parent: parentId, index: index ?? parent.children.length }
  }
  const page = store.activePage()
  return { kind: 'page', pageId: page.id, index: index ?? page.children.length }
}

export const aiToolExecutors: Record<string, (args: Json) => Promise<Json> | Json> = {
  // --- Context / reads -----------------------------------------------------

  get_basic_info() {
    const page = store.activePage()
    const artboards = page.children
      .filter((id) => store.doc.nodes[id]?.isArtboard)
      .map(summarize)
    return {
      document: { id: store.doc.id, name: store.doc.name, schemaVersion: store.doc.schemaVersion },
      page: { id: page.id, name: page.name, topLevelCount: page.children.length },
      artboards,
      nodeCount: Object.keys(store.doc.nodes).length,
      components: Object.values(store.doc.components).map((c) => ({
        id: c.id, name: c.name, rootId: c.rootId, setId: c.setId, variantProps: c.variantProps,
      })),
      tokens: store.doc.tokens,
      selection: store.ui.selection,
      camera: cameraStore.camera,
      hints: [
        'Coordinates are world-space px. Artboard children use coordinates relative to their artboard.',
        'Write HTML with inline styles and/or Tailwind classes; scripts and event handlers are stripped.',
        'Use data-cz-name on written HTML to control layer names.',
      ],
    }
  },

  get_selection() {
    return {
      selection: store.ui.selection.map((pathId) => ({
        pathId,
        ...summarize(pathId.split(':')[0]),
      })),
    }
  },

  get_tree_summary(args) {
    const rootId = args.rootId as string | undefined
    const maxDepth = Math.min((args.depth as number | undefined) ?? 4, 8)
    const page = store.activePage()
    const roots = rootId ? [rootId] : page.children
    const lines = roots.flatMap((id) => treeSummary(id, 0, maxDepth))
    return { tree: lines.join('\n') || '(empty page)' }
  },

  get_children(args) {
    const node = requireNode(args.id as string)
    return { id: node.id, children: node.children.map(summarize) }
  },

  get_node_info(args) {
    const node = requireNode(args.id as string)
    return {
      ...node,
      rect: rectOf(node.id),
      parentSummary: node.parent ? summarize(node.parent) : null,
      childSummaries: node.children.map(summarize),
    }
  },

  get_html(args) {
    const id = args.id as string
    requireNode(id)
    return { html: exportHtml(store.doc, id) }
  },

  get_jsx(args) {
    const id = args.id as string
    requireNode(id)
    return { jsx: exportJsx(store.doc, id) }
  },

  get_computed_styles(args) {
    const id = args.id as string
    requireNode(id)
    const w = world()
    const el = w ? nodeElement(w, id) : null
    if (!el) throw new Error(`Node ${id} is not rendered (hidden ancestor or wrong page).`)
    const cs = getComputedStyle(el)
    const props = (args.properties as string[] | undefined) ?? [
      'display', 'position', 'width', 'height', 'padding', 'margin', 'gap',
      'flex-direction', 'align-items', 'justify-content', 'font-size', 'font-weight',
      'line-height', 'color', 'background-color', 'border-radius', 'border',
      'box-shadow', 'opacity', 'overflow', 'transform',
    ]
    const styles: Record<string, string> = {}
    for (const p of props) styles[p] = cs.getPropertyValue(p)
    return { id, rect: rectOf(id), computed: styles }
  },

  async get_screenshot(args) {
    const id = args.id as string | undefined
    const w = world()
    if (!w) throw new Error('Canvas not mounted')
    let el: HTMLElement | null
    if (id) {
      requireNode(id)
      el = nodeElement(w, id)
    } else {
      const page = store.activePage()
      const firstArtboard = page.children.find((n) => store.doc.nodes[n]?.isArtboard)
      el = firstArtboard ? nodeElement(w, firstArtboard) : null
    }
    if (!el) throw new Error('Nothing to screenshot — create an artboard first.')
    const maxSize = 1200
    const scale = Math.min(1, maxSize / Math.max(el.offsetWidth, el.offsetHeight, 1))
    const dataUrl = await toPng(el, {
      pixelRatio: scale,
      skipFonts: true,
      style: { transform: 'none', rotate: 'none' },
    })
    return { dataUrl, width: el.offsetWidth, height: el.offsetHeight }
  },
}

function collectFrom(nodes: NodeModel[], rootId: string): NodeModel[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: NodeModel[] = []
  const walk = (id: string) => {
    const n = byId.get(id)
    if (!n) return
    out.push(n)
    n.children.forEach(walk)
  }
  walk(rootId)
  return out
}

export async function executeAiTool(tool: string, args: Json): Promise<Json> {
  const executor = aiToolExecutors[tool]
  if (!executor) throw new Error(`Unknown tool: ${tool}`)
  return await executor(args)
}
