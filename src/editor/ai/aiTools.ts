import { toPng } from 'html-to-image'
import { cameraStore } from '../canvas/camera'
import { controllerRef } from '../canvas/CanvasRoot'
import { nodeElement } from '../canvas/geometry'
import { exportHtml, exportJsx } from '../compiler/export'
import { parseHtml, sanitizeStyle } from '../compiler/parse'
import { sanitizeClasses } from '../compiler/allowlist'
import { cssValuePolicyReject, isAllowedCssProp } from '../compiler/allowlist'
import {
  deleteNodes, duplicateNodes, insertHtml, locate, renameNode, setTextContent,
} from '../commands'
import {
  createInstance, createMainComponent, createVariant, deleteComponent,
  detachInstance, setInstanceOverride, setInstanceVariant,
} from '../components/componentCommands'
import { sfSymbolMarkup } from '@/components/SFSymbol'
import { ensureIconRegistries } from '../iconResolver'
import { DEFAULT_WEIGHTS, isSystemFont, isValidFamily, SYSTEM_FONTS, syncDocumentFonts, verifyFontLoaded } from '../fonts'
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
    const maxSize = 1200
    const scale = Math.min(1, maxSize / Math.max(el.offsetWidth, el.offsetHeight, 1))
    // The clone keeps the node's canvas placement (absolute left/top), which
    // shifts content outside the capture viewport — zero it out. Downscale
    // via canvas dimensions; pixelRatio < 1 renders blank in html-to-image.
    const dataUrl = await toPng(el, {
      pixelRatio: 1,
      canvasWidth: Math.round(el.offsetWidth * scale),
      canvasHeight: Math.round(el.offsetHeight * scale),
      skipFonts: true,
      style: { transform: 'none', rotate: 'none', position: 'static', left: '0px', top: '0px', margin: '0' },
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
        const key = prop.toLowerCase().trim()
        if (value === null) {
          // Removals only touch known props; an unknown name can't be set.
          if (isAllowedCssProp(key)) safe[key] = null
          else rejected.push(`${id}:${prop} (unknown property)`)
          continue
        }
        if (!isAllowedCssProp(key)) {
          rejected.push(`${id}:${prop} (unknown property)`)
          continue
        }
        // Layout-model policy (position: fixed/sticky) before the cheaper checks
        // so the reason is specific.
        const policy = cssValuePolicyReject(key, value)
        if (policy) {
          rejected.push(`${id}:${prop} (${policy})`)
          continue
        }
        // Run the same url()/security sanitizer parse-time inline styles get.
        const sanitized = sanitizeStyle(`${key}: ${value}`)
        const cleaned = sanitized[key]
        if (cleaned === undefined) {
          rejected.push(`${id}:${prop} (invalid value)`)
          continue
        }
        // We run in a real browser — let the engine reject bogus values
        // ("banana") that the allowlist can't catch. CSS.supports natively
        // understands var()/calc()/gradients. Guarded so vitest/node (no CSS)
        // accept-by-default and never break. Custom properties (--token) accept
        // any value by spec, so skip the engine check for them.
        if (
          !key.startsWith('--') &&
          typeof CSS !== 'undefined' &&
          typeof CSS.supports === 'function' &&
          !CSS.supports(key, cleaned)
        ) {
          rejected.push(`${id}:${prop} (invalid value)`)
          continue
        }
        safe[key] = cleaned
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
    const name = String(args.name ?? '').trim()
    if (!name) throw new Error('name is required (Apple SF Symbol name, e.g. "heart.fill")')
    const variant = args.variant === 'dualtone' ? 'dualtone' : 'monochrome'
    const size = Math.max(8, Math.min(512, Number(args.size) || 24))
    const style: Record<string, string> = {}
    if (args.x !== undefined || args.y !== undefined) {
      style.position = 'absolute'
      style.left = `${Number(args.x) || 0}px`
      style.top = `${Number(args.y) || 0}px`
    }
    if (args.color) style.color = String(args.color)
    const markup = await sfSymbolMarkup(name, { variant, size, style })
    if (!markup) {
      throw new Error(
        `Unknown SF Symbol: "${name}". Use Apple names like "heart.fill", "pills.fill", "cross.case", "lungs.fill".`,
      )
    }
    const at = locationFor(args.targetId as string | undefined, args.index as number | undefined)
    const { rootIds, dropped } = insertHtml({ ...AI }, markup, at, `AI: insert icon ${name}`)
    if (rootIds.length === 0) throw new Error(`Icon markup rejected: ${dropped.join(', ')}`)
    store.setSelection(rootIds)
    return { ...mutationResult('insert_icon', rootIds), symbol: name, dropped }
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

  rename_page(args) {
    const ref = String(args.page ?? '')
    const page = store.doc.pages.find((p) => p.id === ref)
      ?? store.doc.pages.find((p) => p.name.toLowerCase() === ref.toLowerCase())
    if (!page) throw new Error(`Unknown page: ${ref}. Pages: ${store.doc.pages.map((p) => `${p.name} (${p.id})`).join(', ')}`)
    const name = String(args.name ?? '').trim().slice(0, 60)
    if (!name) throw new Error('name is required')
    store.apply(`AI: rename page ${name}`, [{ t: 'setPageName', id: page.id, name }], 'ai')
    return { ok: true, pageId: page.id, name, undoable: true }
  },

  delete_page(args) {
    const ref = String(args.page ?? '')
    const page = store.doc.pages.find((p) => p.id === ref)
      ?? store.doc.pages.find((p) => p.name.toLowerCase() === ref.toLowerCase())
    if (!page) throw new Error(`Unknown page: ${ref}. Pages: ${store.doc.pages.map((p) => `${p.name} (${p.id})`).join(', ')}`)
    if (store.doc.pages.length <= 1) throw new Error('Cannot delete the only page in the document')
    // Empty the page (removePage refuses a non-empty page), then drop it — one transaction.
    const ops: Op[] = page.children.map((id) => ({ t: 'remove', id }))
    ops.push({ t: 'removePage', id: page.id })
    store.apply(`AI: delete page ${page.name}`, ops, 'ai')
    return { ok: true, deletedPageId: page.id, activePageId: store.doc.activePageId, undoable: true }
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
      builtin: SYSTEM_FONTS,
      usage: 'Reference document fonts as font-family: \'<Family>\', sans-serif. Add new ones with add_font (host system fonts like SF Pro Display / Menlo load from the OS, others from Google Fonts).',
    }
  },

  async add_font(args) {
    const family = String(args.family ?? '').trim()
    if (!isValidFamily(family)) throw new Error(`Invalid font family name: ${family}`)
    const weights = Array.isArray(args.weights) && args.weights.length > 0
      ? (args.weights as number[]).filter((w) => Number.isFinite(w))
      : DEFAULT_WEIGHTS
    // Host OS fonts (SF Pro, Menlo, …) resolve from local glyphs — register
    // them as `system` so nothing is fetched from Google.
    const source = isSystemFont(family) ? 'system' : 'google'
    store.apply(`AI: add font ${family}`, [
      { t: 'setFont', family, font: { family, weights, source } },
    ], 'ai')
    syncDocumentFonts(store.doc)
    const loaded = source === 'system' ? true : await verifyFontLoaded(family)
    return { ok: true, family, weights, source, loaded, undoable: true,
      hint: source === 'system'
        ? `Host font — use font-family: '${family}', sans-serif`
        : loaded ? `Use font-family: '${family}', sans-serif`
                 : 'Family not found on Google Fonts (kept in the document; verify the name)' }
  },

  async import_asset(args) {
    const name = String(args.name ?? 'asset').slice(0, 80)
    let dataUrl = args.dataUrl ? String(args.dataUrl) : ''
    if (!dataUrl && args.url) {
      const res = await fetch(String(args.url))
      if (!res.ok) throw new Error(`Failed to fetch asset: HTTP ${res.status}`)
      const blob = await res.blob()
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('Failed to read asset bytes'))
        reader.readAsDataURL(blob)
      })
    }
    const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new Error('Provide an image as a base64 `dataUrl` (data:image/...;base64,...) or a fetchable `url`')
    const mime = match[1]
    if (!mime.startsWith('image/')) throw new Error(`Unsupported asset type: ${mime} (images only)`)
    const size = Math.floor((match[2].length * 3) / 4)
    const id = genId('asset')
    store.apply(`AI: import asset ${name}`, [{ t: 'addAsset', asset: { id, name, mime, size, url: dataUrl } }], 'ai')
    return { ok: true, assetId: id, name, mime, size, url: dataUrl, undoable: true,
      hint: 'Reference `url` in <img src="..."> or style="background-image: url(\'...\')".' }
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
