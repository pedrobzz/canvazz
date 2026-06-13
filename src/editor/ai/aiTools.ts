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
  createInstance, createMainComponent, createVariant, deleteComponent,
  detachInstance, setInstanceOverride, setInstanceVariant,
} from '../components/componentCommands'
import { sfSymbolMarkup } from '@/components/SFSymbol'
import { ensureIconRegistries } from '../iconResolver'
import { closestIconNames, iconNames, scoreIcons } from '../iconResolver'
import { DEFAULT_WEIGHTS, isValidFamily, syncDocumentFonts, verifyFontLoaded } from '../fonts'
import { genId } from '../model/ids'
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
      pages: store.doc.pages.map((p) => ({
        id: p.id, name: p.name, isActive: p.id === store.doc.activePageId, topLevelCount: p.children.length,
      })),
      fonts: Object.keys(store.doc.fonts ?? {}),
      artboards,
      nodeCount: Object.keys(store.doc.nodes).length,
      components: Object.values(store.doc.components).map((c) => ({
        id: c.id, name: c.name, rootId: c.rootId, setId: c.setId, variantProps: c.variantProps,
      })),
      componentSets: Object.values(store.doc.componentSets).map((s) => ({
        id: s.id, name: s.name, nodeId: s.nodeId, variantIds: s.variantIds, defaultVariantId: s.defaultVariantId,
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

  async get_html(args) {
    const id = args.id as string
    requireNode(id)
    await ensureIconRegistries() // icon overrides export exact glyph content
    return { html: exportHtml(store.doc, id) }
  },

  async get_jsx(args) {
    const id = args.id as string
    requireNode(id)
    await ensureIconRegistries()
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

    const fullW = el.offsetWidth
    const fullH = el.offsetHeight
    // Crop region (node-relative px) clamped into the node box. Default: whole node.
    const region = clampRegion(args.region as Json | undefined, fullW, fullH)
    const maxEdge = Math.max(1, Math.min(4096, Number(args.maxEdge) || 1200))
    // scale, if given, is honored up to the maxEdge ceiling; otherwise we
    // downscale only when the long edge exceeds maxEdge (1:1 below that).
    const requested = Number(args.scale)
    const fit = Math.min(1, maxEdge / Math.max(region.width, region.height, 1))
    const scale = requested > 0 ? Math.min(requested, fit) : fit

    const warnings: string[] = []
    const bg = effectiveBackground(el, warnings)
    // Capture the full node at the target scale, then crop to the region.
    // Neutralize the node's canvas placement (absolute left/top) WITHOUT
    // forcing `static`: static stops the node being a containing block, so an
    // absolutely-positioned child (a hero <h1>) re-anchors to an outer ancestor
    // and vanishes from the box. `relative` with zero offsets renders at the
    // same origin yet still contains abs children. `flow-root` adds a block
    // formatting context so a plain block's child top-margin can't collapse out
    // of the box and clip. pixelRatio < 1 renders blank, so downscale via the
    // canvas dimensions.
    const style: Record<string, string> = {
      transform: 'none', rotate: 'none', position: 'relative', left: '0px', top: '0px', margin: '0',
    }
    const display = getComputedStyle(el).display
    if (display === 'block' || display === 'inline-block' || display === 'inline') {
      style.display = 'flow-root'
    }
    if (bg.image) style.backgroundImage = bg.image
    const dataUrlFull = await toPng(el, {
      pixelRatio: 1,
      canvasWidth: Math.round(fullW * scale),
      canvasHeight: Math.round(fullH * scale),
      skipFonts: true,
      backgroundColor: bg.color,
      style,
    })

    const cropped =
      region.x === 0 && region.y === 0 && region.width === fullW && region.height === fullH
        ? { dataUrl: dataUrlFull, width: Math.round(fullW * scale), height: Math.round(fullH * scale) }
        : await cropDataUrl(dataUrlFull, region, scale)

    return {
      dataUrl: cropped.dataUrl,
      width: cropped.width,
      height: cropped.height,
      capturedRect: region,
      scale: Math.round(scale * 1000) / 1000,
      ...(warnings.length ? { warnings } : {}),
    }
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

  set_visibility(args) {
    const updates = args.updates as Array<{ id: string; visible: boolean }>
    if (!Array.isArray(updates) || updates.length === 0) throw new Error('updates[] is required')
    const ops: Op[] = updates.map(({ id, visible }) => {
      requireNode(id)
      return { t: 'setProps', id, patch: { visible: Boolean(visible) } }
    })
    const tx = store.apply('AI: set visibility', ops, 'ai')
    return mutationResult('set_visibility', tx?.changed ?? [])
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
    const created = createMainComponent({ ...AI }, [id])
    if (!created) throw new Error('Cannot create a component from this node (already a component/instance/artboard?)')
    if (args.name) {
      const def = store.doc.components[created.componentId]
      store.apply('AI: rename component', [
        { t: 'defineComponent', def: { ...def, name: String(args.name) } },
      ], 'ai')
    }
    return {
      ...mutationResult('create_component', [created.instanceId]),
      componentId: created.componentId,
      /** Definition root — its node ids are the canonical override keys. */
      rootId: created.rootId,
      /** Linked instance now sitting where the original node was. */
      instanceId: created.instanceId,
      hint: 'The main moved to the Design System page; instanceId replaced it in place. Override texts/icons via set_instance_overrides keyed by the definition node ids (stable across variants).',
    }
  },

  create_variant(args) {
    const componentId = args.componentId as string
    if (!store.doc.components[componentId]) throw new Error(`Unknown component: ${componentId}`)
    const created = createVariant({ ...AI }, componentId, String(args.name ?? 'variant'))
    if (!created) throw new Error('Failed to create variant')
    return {
      ...mutationResult('create_variant', [created.rootId]),
      variantId: created.variantId,
      rootId: created.rootId,
      /** Base node id -> this variant's clone id, for editing the variant. */
      idMap: created.idMap,
      hint: 'Edit this variant via the idMap clone ids. Instance overrides keep using the BASE definition ids — they apply across all variants.',
    }
  },

  create_instance(args) {
    const componentId = args.componentId as string
    if (!store.doc.components[componentId]) throw new Error(`Unknown component: ${componentId}`)
    const at = locationFor(args.parentId as string | undefined)
    const instanceId = createInstance({ ...AI }, componentId, at, {
      x: (args.x as number | undefined) ?? 0,
      y: (args.y as number | undefined) ?? 0,
    })
    if (!instanceId) throw new Error('Failed to create instance')
    return { ...mutationResult('create_instance', [instanceId]), instanceId }
  },

  detach_instance(args) {
    const instanceId = args.instanceId as string
    requireNode(instanceId)
    const rootId = detachInstance({ ...AI }, instanceId)
    if (!rootId) throw new Error(`${instanceId} is not a component instance`)
    return { ...mutationResult('detach_instance', [rootId]), rootId }
  },

  delete_component(args) {
    const componentId = String(args.componentId ?? '')
    const result = deleteComponent({ ...AI }, componentId)
    if (!result.ok) throw new Error(result.reason)
    return { ok: true, deleted: componentId, undoable: true }
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

  async insert_icon(args) {
    // One item per icon, normalized from either the array form or the legacy
    // single-icon args. The whole batch lands in one undoable transaction.
    const variant = args.variant === 'dualtone' ? 'dualtone' : 'monochrome'
    const items: IconRequest[] = Array.isArray(args.icons)
      ? (args.icons as Json[]).map((it) => normalizeIconRequest(it, args))
      : [normalizeIconRequest(args, args)]
    if (items.length === 0) throw new Error('Provide an icon name or a non-empty icons[] array.')
    if (items.some((it) => !it.name)) {
      throw new Error('Every icon needs a name (Apple SF Symbol name, e.g. "heart.fill").')
    }

    const results: Array<{ name: string; ok: boolean; id?: NodeId; error?: string }> = []
    const ops: Op[] = []
    const createdIds: NodeId[] = []
    // parseHtml dedups against existing ids; track ids minted earlier in this
    // same batch too so two glyphs never collide before they are applied.
    const pending = new Set<string>()

    for (const item of items) {
      const at = locationFor(item.targetId, item.index)
      const style: Record<string, string> = {}
      if (item.x !== undefined || item.y !== undefined) {
        style.position = 'absolute'
        style.left = `${item.x ?? 0}px`
        style.top = `${item.y ?? 0}px`
      }
      if (item.color) style.color = item.color
      const markup = await sfSymbolMarkup(item.name, { variant, size: item.size, style })
      if (!markup) {
        const closest = await closestIconNames(item.name, variant, 5)
        results.push({
          name: item.name,
          ok: false,
          error: `Unknown SF Symbol "${item.name}"${closest.length ? ` — closest: ${closest.join(', ')}` : ''}`,
        })
        continue
      }
      const { nodes, rootIds, dropped } = parseHtml(markup, {
        isIdTaken: (pid) => Boolean(store.doc.nodes[pid]) || pending.has(pid),
      })
      const rootId = rootIds[0]
      if (!rootId) {
        results.push({ name: item.name, ok: false, error: `Icon markup rejected: ${dropped.join(', ')}` })
        continue
      }
      const tree = collectFrom(nodes, rootId)
      for (const n of tree) pending.add(n.id)
      ops.push({ t: 'insertTree', nodes: tree, rootId, at })
      createdIds.push(rootId)
      results.push({ name: item.name, ok: true, id: rootId })
    }

    if (ops.length === 0) {
      const errors = results.map((r) => r.error).filter(Boolean).join('; ')
      throw new Error(errors || 'No icons could be inserted.')
    }
    const label = createdIds.length === 1
      ? `AI: insert icon ${results.find((r) => r.ok)?.name}`
      : `AI: insert ${createdIds.length} icons`
    store.apply(label, ops, 'ai')
    store.setSelection(createdIds)
    return { ...mutationResult('insert_icon', createdIds), variant, createdIds, icons: results }
  },

  create_page(args) {
    const name = String(args.name ?? 'Page').slice(0, 60)
    const page = { id: genId('page'), name, children: [] }
    store.apply(`AI: create page ${name}`, [
      { t: 'addPage', page, index: store.doc.pages.length },
    ], 'ai')
    store.setActivePage(page.id)
    return { ok: true, pageId: page.id, name, active: true }
  },

  open_page(args) {
    const ref = String(args.page ?? '')
    const page = store.doc.pages.find((p) => p.id === ref)
      ?? store.doc.pages.find((p) => p.name.toLowerCase() === ref.toLowerCase())
    if (!page) {
      throw new Error(`Unknown page: ${ref}. Pages: ${store.doc.pages.map((p) => `${p.name} (${p.id})`).join(', ')}`)
    }
    store.setActivePage(page.id)
    return { ok: true, pageId: page.id, name: page.name, topLevelCount: page.children.length }
  },

  set_tokens(args) {
    const set = args.set as Record<string, string | null>
    if (!set || Object.keys(set).length === 0) throw new Error('set{} is required')
    const ops: Op[] = []
    const rejected: string[] = []
    for (const [name, value] of Object.entries(set)) {
      if (!/^[\w-]{1,40}$/.test(name)) {
        rejected.push(name)
        continue
      }
      if (value === null) ops.push({ t: 'setToken', name, value: null })
      else if (sanitizeStyle(`color: ${value}`).color) ops.push({ t: 'setToken', name, value })
      else rejected.push(name)
    }
    if (ops.length === 0) throw new Error(`All tokens rejected: ${rejected.join(', ')}`)
    store.apply('AI: set tokens', ops, 'ai')
    return { ok: true, tokens: store.doc.tokens, rejected, undoable: true }
  },

  get_fonts() {
    return {
      documentFonts: store.doc.fonts ?? {},
      builtin: ['system-ui', 'Arial', 'Helvetica Neue', 'Georgia', 'Times New Roman', 'Courier New', 'Menlo'],
      usage: 'Reference document fonts as font-family: \'<Family>\', sans-serif. Add new ones with add_font.',
    }
  },

  async add_font(args) {
    const family = String(args.family ?? '').trim()
    if (!isValidFamily(family)) throw new Error(`Invalid font family name: ${family}`)
    const weights = Array.isArray(args.weights) && args.weights.length > 0
      ? (args.weights as number[]).filter((w) => Number.isFinite(w))
      : DEFAULT_WEIGHTS
    store.apply(`AI: add font ${family}`, [
      { t: 'setFont', family, font: { family, weights, source: 'google' } },
    ], 'ai')
    syncDocumentFonts(store.doc)
    const loaded = await verifyFontLoaded(family)
    return { ok: true, family, weights, loaded, undoable: true,
      hint: loaded ? `Use font-family: '${family}', sans-serif` : 'Family not found on Google Fonts (kept in the document; verify the name)' }
  },

  select_nodes(args) {
    const ids = (args.ids as string[]).filter((id) => store.doc.nodes[id])
    store.setSelection(ids)
    return { ok: true, selection: ids }
  },

  async export(args) {
    const id = args.id as string
    requireNode(id)
    await ensureIconRegistries()
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

  async search_icons(args) {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('query is required (e.g. "document", "arrow up", "trash")')
    const variant = args.variant === 'dualtone' ? 'dualtone' : 'monochrome'
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 12))
    const names = await iconNames(variant)
    const matches = scoreIcons(query, names, limit)
    return {
      query,
      variant,
      count: matches.length,
      matches,
      hint: matches.length === 0
        ? 'No matches — try a broader single word (the registry uses Apple names like "doc", "tray", "person").'
        : 'Pass any name to insert_icon. Names are exact Apple SF Symbol names.',
    }
  },
}

export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Clamp a requested node-relative crop into the node box. A missing or empty
 * region means "the whole node". Out-of-range values are pulled back in rather
 * than rejected so a slightly-off band request still returns pixels.
 */
export function clampRegion(
  region: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined,
  fullW: number,
  fullH: number,
): CaptureRegion {
  if (!region || (region.x === undefined && region.y === undefined && region.width === undefined && region.height === undefined)) {
    return { x: 0, y: 0, width: fullW, height: fullH }
  }
  const x = Math.max(0, Math.min(Math.round(Number(region.x) || 0), Math.max(0, fullW - 1)))
  const y = Math.max(0, Math.min(Math.round(Number(region.y) || 0), Math.max(0, fullH - 1)))
  const wReq = region.width === undefined ? fullW - x : Math.round(Number(region.width) || 0)
  const hReq = region.height === undefined ? fullH - y : Math.round(Number(region.height) || 0)
  const width = Math.max(1, Math.min(wReq, fullW - x))
  const height = Math.max(1, Math.min(hReq, fullH - y))
  return { x, y, width, height }
}

export interface BgLayer {
  backgroundColor: string
  backgroundImage: string
  /** True for the captured node's own styles (index 0). */
  own?: boolean
  /** True once we have reached the artboard — the walk stops after it. */
  isArtboard?: boolean
}

export interface EffectiveBackground {
  color?: string
  image?: string
  warnings: string[]
}

const bgTransparent = (c: string) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)'
const bgPainted = (img: string) => Boolean(img) && img !== 'none'

/**
 * Pure resolver: given the captured node's styles followed by its ancestors'
 * (nearest first, ending at the artboard), pick the background it visually
 * renders on. Node shots otherwise drop ancestor backgrounds (a hero inner div
 * captured on white because the gradient lives on the parent section). Take the
 * nearest painted color and, if the node has no image of its own, the nearest
 * ancestor image — which is positioned against that ancestor's geometry, so it
 * can only be approximated under a child; warn when that happens.
 */
export function resolveBackgroundLayers(layers: BgLayer[]): EffectiveBackground {
  const out: EffectiveBackground = { warnings: [] }
  const ownImage = layers[0] && bgPainted(layers[0].backgroundImage)
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    if (!out.color && !bgTransparent(layer.backgroundColor)) out.color = layer.backgroundColor
    if (!ownImage && !out.image && i > 0 && bgPainted(layer.backgroundImage)) {
      out.image = layer.backgroundImage
      out.warnings.push(
        'ancestor background image/gradient approximated (positioned against the ancestor, not this node)',
      )
    }
    if (out.color && (out.image || ownImage)) break
    if (layer.isArtboard) break
  }
  return out
}

/** Collect the node's and ancestors' background styles, up to the artboard. */
function backgroundLayers(el: HTMLElement): BgLayer[] {
  const layers: BgLayer[] = []
  const own = getComputedStyle(el)
  layers.push({ backgroundColor: own.backgroundColor, backgroundImage: own.backgroundImage, own: true })
  let node = el.parentElement
  while (node && node.dataset.canvasWorld === undefined) {
    const cs = getComputedStyle(node)
    const isArtboard = Boolean(node.dataset.nodeId && store.doc.nodes[node.dataset.nodeId]?.isArtboard)
    layers.push({ backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage, isArtboard })
    if (isArtboard) break
    node = node.parentElement
  }
  return layers
}

/** The background a node visually renders on, composited from its ancestors. */
function effectiveBackground(el: HTMLElement, warnings: string[]): { color?: string; image?: string } {
  const resolved = resolveBackgroundLayers(backgroundLayers(el))
  warnings.push(...resolved.warnings)
  return { color: resolved.color, image: resolved.image }
}

/** Crop a full-node PNG to a node-relative region (already in scaled px). */
async function cropDataUrl(
  dataUrl: string,
  region: CaptureRegion,
  scale: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to decode capture for cropping'))
    img.src = dataUrl
  })
  const sx = Math.round(region.x * scale)
  const sy = Math.round(region.y * scale)
  const sw = Math.max(1, Math.round(region.width * scale))
  const sh = Math.max(1, Math.round(region.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable for cropping')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  return { dataUrl: canvas.toDataURL('image/png'), width: sw, height: sh }
}

interface IconRequest {
  name: string
  targetId?: string
  size: number
  color?: string
  x?: number
  y?: number
  index?: number
}

/** Normalize one icon spec, falling back to batch-level defaults. */
function normalizeIconRequest(it: Json, defaults: Json): IconRequest {
  const sizeRaw = it.size ?? defaults.size
  return {
    name: String(it.name ?? '').trim(),
    targetId: (it.targetId ?? defaults.targetId) as string | undefined,
    size: Math.max(8, Math.min(512, Number(sizeRaw) || 24)),
    color: it.color !== undefined ? String(it.color) : undefined,
    x: it.x !== undefined ? Number(it.x) || 0 : undefined,
    y: it.y !== undefined ? Number(it.y) || 0 : undefined,
    index: it.index !== undefined ? Number(it.index) : undefined,
  }
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
  // summaries carry live rects. Occluded tabs throttle rAF to a standstill,
  // so race a timeout — a response with stale rects beats a hung tool call.
  if (Array.isArray(result.changedIds) && result.changedIds.length > 0) {
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
      new Promise((r) => setTimeout(r, 250)),
    ])
    result.changed = (result.changedIds as NodeId[]).map(summarize).filter(Boolean)
  }
  return result
}
