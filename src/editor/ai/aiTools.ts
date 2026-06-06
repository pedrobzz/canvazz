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

  // --- Mutations -----------------------------------------------------------

  create_artboard(args) {
    const name = (args.name as string | undefined) ?? 'Frame'
    const node = createArtboard(name, {
      x: (args.x as number | undefined) ?? 0,
      y: (args.y as number | undefined) ?? 0,
      width: (args.width as number | undefined) ?? 375,
      height: (args.height as number | undefined) ?? 667,
    })
    const page = store.activePage()
    store.apply(`AI: create artboard ${name}`, [
      { t: 'insertTree', nodes: [node], rootId: node.id, at: { kind: 'page', pageId: page.id, index: page.children.length } },
    ], 'ai')
    return mutationResult('create_artboard', [node.id])
  },

  write_html(args) {
    const html = String(args.html ?? '')
    if (!html.trim()) throw new Error('html is required')
    const mode = (args.mode as string | undefined) ?? 'insert'
    const targetId = args.targetId as string | undefined

    if (mode === 'replace' && targetId) {
      const target = requireNode(targetId)
      const at = locate(store, targetId)
      if (!at) throw new Error(`Node ${targetId} has no location`)
      // One transaction: remove old, insert new at the same place.
      const { nodes, rootIds, dropped } = parseHtml(html, {
        isIdTaken: (pid) => Boolean(store.doc.nodes[pid]),
      })
      if (rootIds.length === 0) throw new Error(`Nothing valid to insert. Dropped: ${dropped.join(', ')}`)
      // Preserve placement of the replaced node when the new root has none.
      const newRoot = nodes.find((n) => n.id === rootIds[0])
      if (newRoot && !newRoot.style.position && target.style.position === 'absolute') {
        newRoot.style = {
          position: 'absolute',
          left: target.style.left ?? '0px',
          top: target.style.top ?? '0px',
          ...newRoot.style,
        }
      }
      const ops: Op[] = [{ t: 'remove', id: targetId }]
      rootIds.forEach((rootId, i) => {
        ops.push({
          t: 'insertTree',
          nodes: collectFrom(nodes, rootId),
          rootId,
          at: { ...at, index: at.index + i },
        })
      })
      store.apply('AI: replace node', ops, 'ai')
      store.setSelection(rootIds)
      return { ...mutationResult('write_html replace', rootIds), dropped }
    }

    let at: NodeLocation
    if (mode === 'before' || mode === 'after') {
      if (!targetId) throw new Error(`mode "${mode}" requires targetId`)
      const loc = locate(store, targetId)
      if (!loc) throw new Error(`Node ${targetId} has no location`)
      at = { ...loc, index: mode === 'after' ? loc.index + 1 : loc.index }
    } else {
      at = locationFor(targetId, args.index as number | undefined)
    }
    const { rootIds, dropped } = insertHtml({ ...AI }, html, at, 'AI: write html')
    if (rootIds.length === 0) {
      throw new Error(`Nothing valid to insert. Dropped: ${dropped.join(', ') || 'everything (malformed HTML?)'}`)
    }
    store.setSelection(rootIds)
    return { ...mutationResult('write_html', rootIds), dropped }
  },

  update_styles(args) {
    const updates = args.updates as Array<{ id: string; set: Record<string, string | null> }>
    if (!Array.isArray(updates) || updates.length === 0) throw new Error('updates[] is required')
    const ops: Op[] = []
    const rejected: string[] = []
    for (const { id, set } of updates) {
      requireNode(id)
      const safe: Record<string, string | null> = {}
      for (const [prop, value] of Object.entries(set)) {
        if (value === null) {
          safe[prop] = null
          continue
        }
        const sanitized = sanitizeStyle(`${prop}: ${value}`)
        const key = Object.keys(sanitized)[0]
        if (key) safe[key] = sanitized[key]
        else rejected.push(`${id}:${prop}`)
      }
      if (Object.keys(safe).length > 0) ops.push({ t: 'setStyle', id, set: safe })
    }
    if (ops.length === 0) throw new Error(`All style updates rejected: ${rejected.join(', ')}`)
    const tx = store.apply('AI: update styles', ops, 'ai')
    return { ...mutationResult('update_styles', tx?.changed ?? []), rejected }
  },

  set_classes(args) {
    const id = args.id as string
    requireNode(id)
    const classes = sanitizeClasses(String(args.classes ?? ''))
    store.apply('AI: set classes', [{ t: 'setClasses', id, classes }], 'ai')
    return { ...mutationResult('set_classes', [id]), classes }
  },

  set_text_content(args) {
    const id = args.id as string
    requireNode(id)
    setTextContent({ ...AI }, id, String(args.text ?? ''))
    return mutationResult('set_text_content', [id])
  },

  move_nodes(args) {
    const moves = args.moves as Array<{ id: string; parentId?: string; index?: number; x?: number; y?: number }>
    if (!Array.isArray(moves) || moves.length === 0) throw new Error('moves[] is required')
    const ops: Op[] = []
    for (const m of moves) {
      requireNode(m.id)
      if (m.parentId !== undefined || m.index !== undefined) {
        const cur = locate(store, m.id)
        const to: NodeLocation = m.parentId
          ? { kind: 'node', parent: m.parentId, index: m.index ?? requireNode(m.parentId).children.length }
          : m.index !== undefined && cur
            ? { ...cur, index: m.index }
            : locationFor(undefined, m.index)
        ops.push({ t: 'move', id: m.id, to })
      }
      const set: Record<string, string> = {}
      if (m.x !== undefined) set.left = `${m.x}px`
      if (m.y !== undefined) set.top = `${m.y}px`
      if (Object.keys(set).length > 0) {
        set.position = store.doc.nodes[m.id].style.position ?? 'absolute'
        ops.push({ t: 'setStyle', id: m.id, set })
      }
    }
    const tx = store.apply('AI: move nodes', ops, 'ai')
    return mutationResult('move_nodes', tx?.changed ?? [])
  },

  duplicate_nodes(args) {
    const ids = args.ids as string[]
    ids.forEach(requireNode)
    const newIds = duplicateNodes({ ...AI }, ids, (args.offset as number | undefined) ?? 16)
    return mutationResult('duplicate_nodes', newIds)
  },

  delete_nodes(args) {
    const ids = args.ids as string[]
    ids.forEach(requireNode)
    const removed = deleteNodes({ ...AI }, ids)
    return { ok: true, label: 'delete_nodes', changedIds: removed, undoable: true }
  },

  rename_nodes(args) {
    const renames = args.renames as Array<{ id: string; name: string }>
    for (const { id, name } of renames) {
      requireNode(id)
      renameNode({ ...AI }, id, String(name).slice(0, 80))
    }
    return mutationResult('rename_nodes', renames.map((r) => r.id))
  },

  create_component(args) {
    const id = args.nodeId as string
    requireNode(id)
    const componentId = createMainComponent({ ...AI }, [id])
    if (!componentId) throw new Error('Cannot create a component from this node (already a component/instance/artboard?)')
    if (args.name) {
      const def = store.doc.components[componentId]
      store.apply('AI: rename component', [
        { t: 'defineComponent', def: { ...def, name: String(args.name) } },
      ], 'ai')
    }
    return { ...mutationResult('create_component', [id]), componentId }
  },

  create_variant(args) {
    const componentId = args.componentId as string
    if (!store.doc.components[componentId]) throw new Error(`Unknown component: ${componentId}`)
    const variantId = createVariant({ ...AI }, componentId, String(args.name ?? 'variant'))
    if (!variantId) throw new Error('Failed to create variant')
    const def = store.doc.components[variantId]
    return { ...mutationResult('create_variant', [def.rootId]), variantId, rootId: def.rootId }
  },

  set_instance_overrides(args) {
    const instanceId = args.instanceId as string
    const instance = requireNode(instanceId)
    if (!instance.componentId) throw new Error(`${instanceId} is not a component instance`)
    if (args.variantId) {
      if (!setInstanceVariant({ ...AI }, instanceId, String(args.variantId))) {
        throw new Error(`Unknown variant: ${String(args.variantId)}`)
      }
    }
    const overrides = (args.overrides as Record<string, Json> | undefined) ?? {}
    for (const [sourceId, o] of Object.entries(overrides)) {
      const ok = setInstanceOverride({ ...AI }, instanceId, sourceId, {
        text: o.text !== undefined ? String(o.text) : undefined,
        style: o.style as Record<string, string> | undefined,
        classes: o.classes as string[] | undefined,
        visible: o.visible as boolean | undefined,
        componentId: o.componentId as string | undefined,
        variantId: o.variantId as string | undefined,
        attrs: o.attrs as Record<string, string> | undefined,
      })
      if (!ok) throw new Error(`Failed to apply override for ${sourceId}`)
    }
    return mutationResult('set_instance_overrides', [instanceId])
  },

  select_nodes(args) {
    const ids = (args.ids as string[]).filter((id) => store.doc.nodes[id])
    store.setSelection(ids)
    return { ok: true, selection: ids }
  },

  export(args) {
    const id = args.id as string
    requireNode(id)
    const format = (args.format as string | undefined) ?? 'html'
    if (format === 'jsx') return { format, code: exportJsx(store.doc, id) }
    return { format: 'html', code: exportHtml(store.doc, id) }
  },

  undo() {
    const ok = store.undo()
    return { ok, message: ok ? 'Undid last transaction' : 'Nothing to undo' }
  },

  finish(args) {
    // Explicit end-of-task: clear AI indicators, report a final summary.
    store.setUi({ aiChanged: [] })
    return {
      ok: true,
      summary: String(args.summary ?? ''),
      log: store.log.slice(-20),
      nodeCount: Object.keys(store.doc.nodes).length,
    }
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
  const result = await executor(args)
  // Mutations summarize changed nodes; wait for React to paint them so the
  // summaries carry live rects and the model doesn't need a follow-up read.
  if (Array.isArray(result.changedIds) && result.changedIds.length > 0) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    result.changed = (result.changedIds as NodeId[]).map(summarize).filter(Boolean)
  }
  return result
}
