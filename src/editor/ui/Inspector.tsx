import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/Icon'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { exportHtml, exportJsx } from '../compiler/export'
import { isAllowedCssProp, isSafeCssValue, sanitizeClasses, sanitizeUrl } from '../compiler/allowlist'
import { controllerRef } from '../canvas/CanvasRoot'
import { px, fmtPx } from '../canvas/geometry'
import { canonicalSourceId, effectiveComponentRoot, parsePathId, stripPlacement } from '../model/instances'
import {
  createMainComponent, detachInstance, setInstanceOverride, setInstanceVariant, variantsOf,
} from '../components/componentCommands'
import { renameNode } from '../commands'
import { replaceNodeWithIcon } from '../icons'
import { SFSymbol } from '@/components/SFSymbol'
import { editorStore } from '../store/editorStore'
import { useDocVersion, useUi } from '../store/hooks'
import {
  ActionRow, AlignmentGrid, CheckRow, ColorField, FieldLabel, IconButton, IconRow,
  NumberField, Row, Section, SelectField, SizeField, TextField,
} from './fields'
import type { CommitOpts, SizeMode } from './fields'
import type { NodeId, NodeModel, Op } from '../model/types'

/**
 * Right-hand inspector. Sections adapt to the selection type and write
 * straight to the model (one transaction per commit; scrub gestures merge
 * into one undo entry via their gestureId). Selecting inside a component
 * instance writes overrides instead of touching the definition. The panel is
 * resizable and never scrolls horizontally.
 */

function writeStyle(
  pathIds: string[],
  set: Record<string, string | null>,
  label = 'Edit style',
  opts?: CommitOpts,
) {
  const safe: Record<string, string | null> = {}
  for (const [prop, value] of Object.entries(set)) {
    if (value === null) safe[prop] = null
    else if (isAllowedCssProp(prop) && isSafeCssValue(value)) safe[prop] = value
  }
  if (Object.keys(safe).length === 0) return
  const ops: Op[] = []
  for (const pathId of pathIds) {
    const { instanceId, sourceId } = parsePathId(pathId)
    if (instanceId && instanceId !== pathId) {
      // Overrides key by the canonical (base-definition) id so they apply
      // across variants. Direct edits keep the literal node id.
      const key = canonicalSourceId(editorStore.doc, sourceId)
      const instance = editorStore.doc.nodes[instanceId]
      const prev = instance?.overrides?.[key]?.style ?? {}
      const style = { ...prev }
      for (const [k, v] of Object.entries(safe)) {
        if (v === null) delete style[k]
        else style[k] = v
      }
      ops.push({ t: 'setOverride', id: instanceId, sourceId: key, patch: { style } })
    } else {
      ops.push({ t: 'setStyle', id: sourceId, set: safe })
    }
  }
  editorStore.apply(label, ops, 'user', { mergeKey: opts?.gestureId })
}

/** Effective node values for a selection path (override-merged for internals). */
function effectiveNode(pathId: string): NodeModel | null {
  const { instanceId, sourceId } = parsePathId(pathId)
  const base = editorStore.doc.nodes[sourceId]
  if (!base) return null
  if (!instanceId || instanceId === pathId) {
    // Instance roots inherit the component definition's styling (the canvas
    // renders def style under instance style); mirror that here so the
    // inspector shows what is actually painted.
    if (base.componentId) {
      const rootId = effectiveComponentRoot(editorStore.doc, base)
      const defRoot = rootId ? editorStore.doc.nodes[rootId] : null
      if (defRoot) {
        return {
          ...base,
          tag: defRoot.tag,
          style: { ...stripPlacement(defRoot.style), ...base.style },
          classes: base.classes.length > 0 ? base.classes : defRoot.classes,
          text: base.text ?? defRoot.text,
          attrs: { ...defRoot.attrs, ...base.attrs },
        }
      }
    }
    return base
  }
  const override =
    editorStore.doc.nodes[instanceId]?.overrides?.[canonicalSourceId(editorStore.doc, sourceId)]
  if (!override) return base
  return {
    ...base,
    style: { ...base.style, ...override.style },
    classes: override.classes ?? base.classes,
    text: override.text ?? base.text,
    visible: override.visible ?? base.visible,
    attrs: { ...base.attrs, ...override.attrs },
  }
}

type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** Align absolutely-positioned nodes within their parent's box. */
function alignInParent(pathIds: string[], mode: AlignMode) {
  const ops: Op[] = []
  for (const pathId of pathIds) {
    const { instanceId, sourceId } = parsePathId(pathId)
    if (instanceId && instanceId !== pathId) continue
    const node = editorStore.doc.nodes[sourceId]
    if (!node?.parent || node.style.position !== 'absolute') continue
    const rect = controllerRef.current?.rectOf(sourceId)
    const parentRect = controllerRef.current?.rectOf(node.parent)
    if (!rect || !parentRect) continue
    const set: Record<string, string> = {}
    if (mode === 'left') set.left = '0px'
    if (mode === 'hcenter') set.left = fmtPx((parentRect.width - rect.width) / 2)
    if (mode === 'right') set.left = fmtPx(parentRect.width - rect.width)
    if (mode === 'top') set.top = '0px'
    if (mode === 'vcenter') set.top = fmtPx((parentRect.height - rect.height) / 2)
    if (mode === 'bottom') set.top = fmtPx(parentRect.height - rect.height)
    ops.push({ t: 'setStyle', id: sourceId, set })
  }
  if (ops.length > 0) editorStore.apply('Align', ops)
}

const MIN_W = 240
const MAX_W = 440

export function Inspector() {
  useDocVersion()
  const ui = useUi()
  const pathIds = ui.selection
  const first = pathIds[0] ? effectiveNode(pathIds[0]) : null

  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return 264
    const saved = Number(window.localStorage.getItem('cz-inspector-w'))
    return saved >= MIN_W && saved <= MAX_W ? saved : 264
  })
  const resizing = useRef<{ startX: number; startW: number } | null>(null)

  return (
    <div
      data-cz-ui
      data-testid="inspector"
      style={{ width }}
      className="cz-panel relative flex h-full shrink-0 flex-col overflow-y-auto overflow-x-hidden border-l border-[var(--cz-panel-border)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-[var(--cz-accent)]/50"
        onPointerDown={(e) => {
          resizing.current = { startX: e.clientX, startW: width }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!resizing.current) return
          const next = Math.min(MAX_W, Math.max(MIN_W, resizing.current.startW + (resizing.current.startX - e.clientX)))
          setWidth(next)
        }}
        onPointerUp={(e) => {
          resizing.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
          window.localStorage.setItem('cz-inspector-w', String(width))
        }}
      />
      {!first ? <EmptyInspector /> : (
        <SelectionInspector key={pathIds.join(',')} pathIds={pathIds} node={first} />
      )}
    </div>
  )
}

function EmptyInspector() {
  const doc = editorStore.doc
  return (
    <>
      <Section title="Document">
        <TextField
          value={doc.name}
          onCommit={(name) => {
            editorStore.doc = { ...doc, name }
            editorStore.setUi({})
          }}
        />
        <div className="text-[10px] text-[var(--cz-panel-muted)]">
          {Object.keys(doc.nodes).length} nodes · {doc.pages.length} page(s) ·{' '}
          {Object.keys(doc.components).length} component(s)
        </div>
      </Section>
      <Section title="Canvas">
        <div className="text-[10px] leading-relaxed text-[var(--cz-panel-muted)]">
          Select a layer to inspect it. Draw with <kbd>F</kbd> frame, <kbd>R</kbd> rectangle,{' '}
          <kbd>O</kbd> ellipse, <kbd>T</kbd> text. Space-drag pans, ⌘-scroll zooms. Double-click
          selects the exact layer under the cursor.
        </div>
      </Section>
    </>
  )
}

type StyleWrite = (set: Record<string, string | null>, label?: string, opts?: CommitOpts) => void

type Flow = 'column' | 'row' | 'free' | 'grid'

function SelectionInspector({ pathIds, node }: { pathIds: string[]; node: NodeModel }) {
  const { instanceId, sourceId } = parsePathId(pathIds[0])
  const isInternal = Boolean(instanceId && instanceId !== pathIds[0])
  const multi = pathIds.length > 1
  const s = node.style
  const isInstance = Boolean(node.componentId)
  const isText = node.text !== undefined ||
    ['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'li'].includes(node.tag)
  const isContainer = !isInstance &&
    ['div', 'section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'ul', 'ol'].includes(node.tag)
  const parent = node.parent ? editorStore.doc.nodes[node.parent] : null
  const inFlexParent = Boolean(parent && (parent.style.display === 'flex' || parent.classes.includes('flex')))
  const isAbsolute = s.position === 'absolute'

  const [tab, setTab] = useState<'design' | 'css'>('design')

  const write: StyleWrite = (set, label, opts) => writeStyle(pathIds, set, label, opts)
  const writeNum = (prop: string, unit = 'px') => (v: number, o?: CommitOpts) =>
    write({ [prop]: `${v}${unit}` }, undefined, o)

  // --- Figma-style sizing: Fixed / Fit / Fill per axis, direction-aware.
  // In a flex parent, "fill" along the main axis means flex-grow; along the
  // cross axis it means align-self: stretch. Outside flex it means 100%.
  const parentDirRaw = parent?.style['flex-direction'] ?? (parent?.classes.includes('flex-col') ? 'column' : 'row')
  const parentRow = !String(parentDirRaw).startsWith('column')
  const flowChild = inFlexParent && !isAbsolute
  const axisInfo = (axis: 'w' | 'h') => ({
    prop: axis === 'w' ? 'width' : 'height',
    main: flowChild && (axis === 'w') === parentRow,
    cross: flowChild && (axis === 'w') !== parentRow,
  })

  const sizeOf = (axis: 'w' | 'h'): { mode: SizeMode; display: string } => {
    const { prop, main, cross } = axisInfo(axis)
    const v = s[prop]
    if (v) {
      if (v === '100%') return { mode: 'fill', display: '' }
      if (v === 'fit-content' || v === 'max-content' || v === 'auto') return { mode: 'fit', display: '' }
      const n = px(v)
      return { mode: 'fixed', display: n !== null ? String(n) : v }
    }
    if (main) return s['flex-grow'] || s.flex ? { mode: 'fill', display: '' } : { mode: 'fit', display: '' }
    if (cross) {
      return s['align-self'] && s['align-self'] !== 'stretch'
        ? { mode: 'fit', display: '' }
        : { mode: 'fill', display: '' }
    }
    if (axis === 'w' && !isAbsolute && parent) return { mode: 'fill', display: '' } // block fills
    return { mode: 'fit', display: '' }
  }

  // Live rects force a layout pass on the whole canvas — read lazily and at
  // most once per render, only for fields that actually need them.
  let rectCache: { rect: ReturnType<NonNullable<typeof controllerRef.current>['rectOf']>; parent: ReturnType<NonNullable<typeof controllerRef.current>['rectOf']> } | undefined
  const liveRects = () => {
    if (rectCache === undefined) {
      rectCache = {
        rect: controllerRef.current?.rectOf(pathIds[0]) ?? null,
        parent: node.parent ? controllerRef.current?.rectOf(node.parent) ?? null : null,
      }
    }
    return rectCache
  }
  const liveXY = (axis: 'x' | 'y') => {
    const { rect, parent } = liveRects()
    return rect ? Math.round(rect[axis] - (parent?.[axis] ?? 0)) : null
  }

  const applySizeFixed = (axis: 'w' | 'h') => (raw: string, o?: CommitOpts) => {
    const { prop, main, cross } = axisInfo(axis)
    const trimmed = raw.trim()
    let value: string
    if (/^-?[\d.]+%$/.test(trimmed)) {
      value = trimmed
    } else {
      const n = parseFloat(trimmed)
      if (Number.isNaN(n)) {
        // Switching to Fixed without a value freezes the rendered size.
        const rect = controllerRef.current?.rectOf(pathIds[0])
        value = `${Math.round((axis === 'w' ? rect?.width : rect?.height) ?? 100)}px`
      } else {
        value = `${Math.max(1, n)}px`
      }
    }
    const set: Record<string, string | null> = { [prop]: value }
    if (main) {
      set['flex-grow'] = null
      set['flex-basis'] = null
    }
    if (cross && s['align-self'] === 'stretch') set['align-self'] = null
    write(set, 'Resize', o)
  }

  const applySizeMode = (axis: 'w' | 'h') => (mode: SizeMode) => {
    const { prop, main, cross } = axisInfo(axis)
    const set: Record<string, string | null> = {}
    if (mode === 'fit') {
      set[prop] = axis === 'w' ? 'fit-content' : null
      if (main) {
        set['flex-grow'] = null
        set['flex-basis'] = null
      }
      if (cross) set['align-self'] = 'flex-start'
    } else if (mode === 'fill') {
      if (main) {
        set['flex-grow'] = '1'
        set['flex-basis'] = '0'
        set[prop] = null
      } else if (cross) {
        set['align-self'] = 'stretch'
        set[prop] = null
      } else {
        set[prop] = '100%'
      }
    }
    write(set, 'Resize')
  }

  /** Paired box writes (padding/margin X/Y) expanding shorthands. */
  const writePair = (props: [string, string], shorthand: string, keepProps: [string, string]) =>
    (v: number, o?: CommitOpts) => {
      const keep = px(s[keepProps[0]] ?? s[shorthand])
      const set: Record<string, string | null> = {
        [props[0]]: `${v}px`, [props[1]]: `${v}px`, [shorthand]: null,
      }
      if (keep !== null) {
        set[keepProps[0]] = `${keep}px`
        set[keepProps[1]] = `${keep}px`
      }
      return write(set, undefined, o)
    }

  // --- Transform actions: rotate 90deg steps and axis flips (CSS scale).
  const rotate90 = () => {
    const cur = s.rotate ? parseFloat(s.rotate) || 0 : 0
    const next = (cur + 90) % 360
    write({ rotate: next === 0 ? null : `${next}deg` }, 'Rotate')
  }
  const flip = (axis: 'x' | 'y') => {
    const parts = (s.scale ?? '1 1').trim().split(/\s+/)
    let sx = parts[0] ?? '1'
    let sy = parts[1] ?? parts[0] ?? '1'
    if (axis === 'x') sx = sx.startsWith('-') ? sx.slice(1) : `-${sx}`
    else sy = sy.startsWith('-') ? sy.slice(1) : `-${sy}`
    write({ scale: sx === '1' && sy === '1' ? null : `${sx} ${sy}` }, 'Flip')
  }

  // --- Constraints: which CSS props pin the box inside its parent.
  const hAnchor = s.right && !s.left ? 'right' : s.left?.includes('calc(50%') ? 'center' : 'left'
  const vAnchor = s.bottom && !s.top ? 'bottom' : s.top?.includes('calc(50%') ? 'center' : 'top'
  const setAnchor = (axis: 'h' | 'v') => (mode: string) => {
    const node = editorStore.doc.nodes[sourceId]
    if (!node?.parent) return
    const rect = controllerRef.current?.rectOf(sourceId)
    const parentRect = controllerRef.current?.rectOf(node.parent)
    if (!rect || !parentRect) return
    const r = (n: number) => Math.round(n * 100) / 100
    const set: Record<string, string | null> = {}
    if (axis === 'h') {
      const rel = rect.x - parentRect.x
      if (mode === 'left') { set.left = fmtPx(rel); set.right = null }
      if (mode === 'right') { set.right = fmtPx(parentRect.width - rel - rect.width); set.left = null }
      if (mode === 'center') { set.left = `calc(50% + ${r(rel - parentRect.width / 2)}px)`; set.right = null }
    } else {
      const rel = rect.y - parentRect.y
      if (mode === 'top') { set.top = fmtPx(rel); set.bottom = null }
      if (mode === 'bottom') { set.bottom = fmtPx(parentRect.height - rel - rect.height); set.top = null }
      if (mode === 'center') { set.top = `calc(50% + ${r(rel - parentRect.height / 2)}px)`; set.bottom = null }
    }
    write(set, 'Pin')
  }

  // --- Position absolute toggle (the Position header action).
  const toggleAbsolute = () => {
    if (isAbsolute) {
      write({ position: null, left: null, top: null, right: null, bottom: null }, 'Place in layout')
    } else {
      const rect = controllerRef.current?.rectOf(pathIds[0])
      const parentRect = node.parent ? controllerRef.current?.rectOf(node.parent) : null
      const set: Record<string, string | null> = { position: 'absolute' }
      if (rect && parentRect) {
        set.left = fmtPx(rect.x - parentRect.x)
        set.top = fmtPx(rect.y - parentRect.y)
        set.width = fmtPx(rect.width)
        set.height = fmtPx(rect.height)
      }
      write(set, 'Absolute position')
    }
  }

  // --- Flow: one segmented control instead of display/direction dropdowns.
  const displayValue = s.display ??
    (node.classes.includes('grid') ? 'grid'
      : node.classes.some((c) => c === 'flex' || c === 'inline-flex') ? 'flex' : 'block')
  const dirColumn = (s['flex-direction'] ?? (node.classes.includes('flex-col') ? 'column' : 'row'))
    .startsWith('column')
  const flow: Flow = displayValue === 'grid' ? 'grid'
    : displayValue === 'flex' || displayValue === 'inline-flex' ? (dirColumn ? 'column' : 'row')
    : 'free'
  const setFlow = (next: Flow) => {
    const sets: Record<Flow, Record<string, string | null>> = {
      free: { display: null, 'flex-direction': null },
      row: { display: 'flex', 'flex-direction': null },
      column: { display: 'flex', 'flex-direction': 'column' },
      grid: { display: 'grid', 'flex-direction': null },
    }
    write(sets[next], 'Set flow')
  }
  const isFlex = flow === 'row' || flow === 'column'

  // Per-side / per-corner expanders.
  const [padSides, setPadSides] = useState(false)
  const [corners, setCorners] = useState(false)

  return (
    <>
      <div className="flex items-center gap-1 border-b border-[var(--cz-panel-border)] px-3 py-2">
        {(['design', 'css'] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
              tab === t
                ? 'bg-[var(--cz-panel-active)] text-white'
                : 'text-[var(--cz-panel-muted)] hover:text-white'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'css' ? 'CSS' : 'Design'}
          </button>
        ))}
      </div>

      <Section title={multi ? `${pathIds.length} selected` : node.name}>
        {!multi && !isInternal ? (
          <Row>
            <TextField value={node.name} onCommit={(name) => renameNode({ store: editorStore }, sourceId, name)} />
            <span className="shrink-0 rounded bg-[var(--cz-panel-hover)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--cz-panel-muted)]">
              {node.tag}
            </span>
          </Row>
        ) : null}
        {isInternal ? (
          <div className="text-[10px] text-[var(--cz-ai)]">Editing instance override</div>
        ) : null}
      </Section>

      {tab === 'css' ? (
        <CssTab pathIds={pathIds} node={node} write={write} />
      ) : (
        <>
          {node.tag === 'svg' && !isInternal ? (
            <IconSection sourceId={sourceId} node={node} />
          ) : null}

          {isInstance && node.componentId ? (
            <ComponentSection instanceId={sourceId} componentId={node.componentId} variantId={node.variantId} />
          ) : null}
          {node.isComponentRoot ? (
            <Section title="Component">
              <div className="text-[10px] text-[var(--cz-ai)]">
                Main component — edits propagate to all instances.
              </div>
            </Section>
          ) : null}
          {!isInstance && !node.isComponentRoot && !isInternal && !multi && !node.isArtboard ? (
            <Section
              title="Component"
              actions={
                <Button
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-[var(--cz-ai)] hover:bg-[var(--cz-panel-hover)]"
                  onClick={() => createMainComponent({ store: editorStore }, [sourceId])}
                >
                  Create
                </Button>
              }
            >
              <div className="text-[10px] text-[var(--cz-panel-muted)]">Turn this layer into a reusable component.</div>
            </Section>
          ) : null}

          <Section
            title="Position"
            actions={
              !node.isArtboard ? (
                <IconButton
                  label={isAbsolute ? 'Place in layout flow' : 'Enable absolute positioning'}
                  active={isAbsolute}
                  onClick={toggleAbsolute}
                >
                  <Icon name="rectangle.dashed" size={13} />
                </IconButton>
              ) : undefined
            }
          >
            {isAbsolute ? (
              <ActionRow
                fullWidth
                actions={[
                  { icon: <Icon name="align.horizontal.left" size={14} />, label: 'Align left', onClick: () => alignInParent(pathIds, 'left') },
                  { icon: <Icon name="align.horizontal.center" size={14} />, label: 'Align horizontal centers', onClick: () => alignInParent(pathIds, 'hcenter') },
                  { icon: <Icon name="align.horizontal.right" size={14} />, label: 'Align right', onClick: () => alignInParent(pathIds, 'right') },
                  { icon: <Icon name="align.vertical.top" size={14} />, label: 'Align top', onClick: () => alignInParent(pathIds, 'top') },
                  { icon: <Icon name="align.vertical.center" size={14} />, label: 'Align vertical centers', onClick: () => alignInParent(pathIds, 'vcenter') },
                  { icon: <Icon name="align.vertical.bottom" size={14} />, label: 'Align bottom', onClick: () => alignInParent(pathIds, 'bottom') },
                ]}
              />
            ) : null}
            <Row>
              <NumberField
                label="X" title="X position"
                value={px(s.left) ?? liveXY('x')}
                onCommit={writeNum('left')} disabled={!isAbsolute}
              />
              <NumberField
                label="Y" title="Y position"
                value={px(s.top) ?? liveXY('y')}
                onCommit={writeNum('top')} disabled={!isAbsolute}
              />
              <NumberField
                label="Z" title="Z index" unit=""
                value={s['z-index'] ? parseFloat(s['z-index']) || 0 : 0}
                onCommit={(v, o) => write({ 'z-index': v === 0 ? null : String(Math.round(v)) }, undefined, o)}
              />
            </Row>
            <Row>
              <NumberField
                label={<Icon name="angle" size={12} />}
                title="Rotation"
                value={s.rotate ? parseFloat(s.rotate) || 0 : 0}
                unit="°"
                onCommit={(v, o) => write({ rotate: v === 0 ? null : `${v}deg` }, undefined, o)}
              />
              <ActionRow
                actions={[
                  { icon: <Icon name="arrow.trianglehead.2.clockwise.rotate.90" size={13} />, label: 'Rotate 90°', onClick: rotate90 },
                  { icon: <Icon name="trapezoid.and.line.vertical" size={13} />, label: 'Flip horizontal', onClick: () => flip('x') },
                  { icon: <Icon name="trapezoid.and.line.horizontal" size={13} />, label: 'Flip vertical', onClick: () => flip('y') },
                ]}
              />
            </Row>
            {isAbsolute && parent ? (
              <>
                <FieldLabel>Constraints</FieldLabel>
                <Row>
                  <SelectField
                    value={hAnchor}
                    options={[
                      { value: 'left', label: 'Left' },
                      { value: 'right', label: 'Right' },
                      { value: 'center', label: 'Center' },
                    ]}
                    onCommit={setAnchor('h')}
                  />
                  <SelectField
                    value={vAnchor}
                    options={[
                      { value: 'top', label: 'Top' },
                      { value: 'bottom', label: 'Bottom' },
                      { value: 'center', label: 'Center' },
                    ]}
                    onCommit={setAnchor('v')}
                  />
                </Row>
              </>
            ) : null}
          </Section>

          <Section title="Layout">
            {isContainer ? (
              <>
                <FieldLabel>Flow</FieldLabel>
                <IconRow
                  ariaLabel="Flow"
                  value={flow}
                  options={[
                    { value: 'column', icon: <Icon name="square.split.1x2" size={14} />, label: 'Vertical stack' },
                    { value: 'row', icon: <Icon name="square.split.2x1" size={14} />, label: 'Horizontal stack' },
                    { value: 'free', icon: <Icon name="square.on.square" size={14} />, label: 'Freeform' },
                    { value: 'grid', icon: <Icon name="square.grid.2x2" size={14} />, label: 'Grid' },
                  ]}
                  onChange={setFlow}
                />
              </>
            ) : null}
            <FieldLabel>Dimensions</FieldLabel>
            <Row>
              <SizeField
                label="W" title="Width" {...sizeOf('w')} live={() => liveRects().rect?.width ?? null}
                onFixed={applySizeFixed('w')} onMode={applySizeMode('w')}
              />
              <SizeField
                label="H" title="Height" {...sizeOf('h')} live={() => liveRects().rect?.height ?? null}
                onFixed={applySizeFixed('h')} onMode={applySizeMode('h')}
              />
            </Row>
            {isContainer && isFlex ? (
              <div className="flex items-start gap-2">
                <div className="flex flex-col gap-1">
                  <FieldLabel>Alignment</FieldLabel>
                  <AlignmentGrid
                    direction={flow === 'column' ? 'column' : 'row'}
                    justify={s['justify-content'] ?? ''}
                    align={s['align-items'] ?? ''}
                    onChange={(j, a) =>
                      write({ 'justify-content': j === 'flex-start' ? null : j, 'align-items': a })
                    }
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <FieldLabel>Gap</FieldLabel>
                  <NumberField
                    label={<Icon name={flow === 'column' ? 'arrow.up.and.down' : 'arrow.left.and.right'} size={12} />}
                    title="Gap"
                    value={px(s.gap ?? s['column-gap'] ?? s['row-gap']) ?? 0}
                    min={0}
                    onCommit={(v, o) =>
                      write({ gap: `${v}px`, 'row-gap': null, 'column-gap': null }, undefined, o)
                    }
                  />
                  <CheckRow
                    label="Wrap"
                    checked={s['flex-wrap'] === 'wrap'}
                    onChange={(checked) => write({ 'flex-wrap': checked ? 'wrap' : null })}
                  />
                </div>
              </div>
            ) : null}
            {isContainer ? (
              <>
                <FieldLabel
                  action={
                    <IconButton
                      label="Independent padding"
                      active={padSides}
                      onClick={() => setPadSides(!padSides)}
                    >
                      <Icon name="square.split.2x2" size={12} />
                    </IconButton>
                  }
                >
                  Padding
                </FieldLabel>
                {padSides ? (
                  <>
                    <Row>
                      <NumberField label="T" title="Padding top" value={px(s['padding-top'] ?? s.padding) ?? 0} min={0}
                        onCommit={(v, o) => write({ 'padding-top': `${v}px`, padding: null }, undefined, o)} />
                      <NumberField label="R" title="Padding right" value={px(s['padding-right'] ?? s.padding) ?? 0} min={0}
                        onCommit={(v, o) => write({ 'padding-right': `${v}px`, padding: null }, undefined, o)} />
                    </Row>
                    <Row>
                      <NumberField label="B" title="Padding bottom" value={px(s['padding-bottom'] ?? s.padding) ?? 0} min={0}
                        onCommit={(v, o) => write({ 'padding-bottom': `${v}px`, padding: null }, undefined, o)} />
                      <NumberField label="L" title="Padding left" value={px(s['padding-left'] ?? s.padding) ?? 0} min={0}
                        onCommit={(v, o) => write({ 'padding-left': `${v}px`, padding: null }, undefined, o)} />
                    </Row>
                  </>
                ) : (
                  <Row>
                    <NumberField
                      label={<Icon name="arrow.left.and.right" size={12} />}
                      title="Horizontal padding"
                      value={px(s['padding-left'] ?? s.padding) ?? 0}
                      min={0}
                      onCommit={writePair(['padding-left', 'padding-right'], 'padding', ['padding-top', 'padding-bottom'])}
                    />
                    <NumberField
                      label={<Icon name="arrow.up.and.down" size={12} />}
                      title="Vertical padding"
                      value={px(s['padding-top'] ?? s.padding) ?? 0}
                      min={0}
                      onCommit={writePair(['padding-top', 'padding-bottom'], 'padding', ['padding-left', 'padding-right'])}
                    />
                  </Row>
                )}
                <CheckRow
                  label="Clip content"
                  checked={s.overflow === 'hidden'}
                  onChange={(checked) => write({ overflow: checked ? 'hidden' : null })}
                />
              </>
            ) : null}
            {flowChild ? (
              <>
                <FieldLabel>Margin</FieldLabel>
                <Row>
                  <NumberField
                    label={<Icon name="arrow.left.and.right" size={12} />}
                    title="Horizontal margin"
                    value={px(s['margin-left'] ?? s.margin) ?? 0}
                    min={0}
                    onCommit={writePair(['margin-left', 'margin-right'], 'margin', ['margin-top', 'margin-bottom'])}
                  />
                  <NumberField
                    label={<Icon name="arrow.up.and.down" size={12} />}
                    title="Vertical margin"
                    value={px(s['margin-top'] ?? s.margin) ?? 0}
                    min={0}
                    onCommit={writePair(['margin-top', 'margin-bottom'], 'margin', ['margin-left', 'margin-right'])}
                  />
                </Row>
                <SelectField
                  label="Self"
                  value={s['align-self'] ?? 'auto'}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'flex-start', label: 'Start' },
                    { value: 'center', label: 'Center' },
                    { value: 'flex-end', label: 'End' },
                    { value: 'stretch', label: 'Stretch' },
                  ]}
                  onCommit={(v) => write({ 'align-self': v === 'auto' ? null : v })}
                />
              </>
            ) : null}
            <CheckRow
              label="Border box"
              checked={(s['box-sizing'] ?? 'border-box') === 'border-box'}
              onChange={(checked) => write({ 'box-sizing': checked ? null : 'content-box' })}
            />
          </Section>

          <Section title="Appearance">
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldLabel>Opacity</FieldLabel>
                <NumberField
                  label={<Icon name="circle.lefthalf.filled" size={12} />}
                  title="Opacity"
                  value={s.opacity ? Math.round(parseFloat(s.opacity) * 100) : 100}
                  min={0} max={100}
                  unit="%"
                  onCommit={(v, o) => write({ opacity: v >= 100 ? null : String(v / 100) }, undefined, o)}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldLabel
                  action={
                    <IconButton label="Independent corners" active={corners} onClick={() => setCorners(!corners)}>
                      <Icon name="viewfinder" size={12} />
                    </IconButton>
                  }
                >
                  Corner Radius
                </FieldLabel>
                <NumberField
                  label={<Icon name="app" size={12} />}
                  title="Corner radius"
                  value={px(s['border-radius']) ?? (s['border-radius'] ? null : 0)}
                  min={0}
                  onCommit={writeNum('border-radius')}
                />
              </div>
            </div>
            {corners ? (
              <>
                <Row>
                  <NumberField label="◜" title="Top left radius" value={px(s['border-top-left-radius'] ?? s['border-radius']) ?? 0} min={0}
                    onCommit={(v, o) => write({ 'border-top-left-radius': `${v}px`, 'border-radius': null }, undefined, o)} />
                  <NumberField label="◝" title="Top right radius" value={px(s['border-top-right-radius'] ?? s['border-radius']) ?? 0} min={0}
                    onCommit={(v, o) => write({ 'border-top-right-radius': `${v}px`, 'border-radius': null }, undefined, o)} />
                </Row>
                <Row>
                  <NumberField label="◟" title="Bottom left radius" value={px(s['border-bottom-left-radius'] ?? s['border-radius']) ?? 0} min={0}
                    onCommit={(v, o) => write({ 'border-bottom-left-radius': `${v}px`, 'border-radius': null }, undefined, o)} />
                  <NumberField label="◞" title="Bottom right radius" value={px(s['border-bottom-right-radius'] ?? s['border-radius']) ?? 0} min={0}
                    onCommit={(v, o) => write({ 'border-bottom-right-radius': `${v}px`, 'border-radius': null }, undefined, o)} />
                </Row>
              </>
            ) : null}
            <SelectField
              label="Blend"
              value={s['mix-blend-mode'] ?? 'normal'}
              options={['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'].map((v) => ({
                value: v, label: v,
              }))}
              onCommit={(v) => write({ 'mix-blend-mode': v === 'normal' ? null : v })}
            />
          </Section>

          {isText ? <TextSection s={s} write={write} /> : null}

          <BackgroundSection s={s} write={write} node={node} sourceId={sourceId} />
          <BorderSection s={s} write={write} />
          <EffectsSection s={s} write={write} />

          {!multi ? <PropertiesSection sourceId={sourceId} /> : null}
          {!multi ? <ExportSection pathId={pathIds[0]} /> : null}
        </>
      )}
    </>
  )
}

/** CSS escape hatch: Tailwind classes, raw filters, and the inline styles. */
function CssTab({ pathIds, node, write }: { pathIds: string[]; node: NodeModel; write: StyleWrite }) {
  const s = node.style
  return (
    <>
      <Section title="Tailwind classes">
        <TextField
          value={node.classes.join(' ')}
          placeholder="flex items-center gap-2…"
          mono
          onCommit={(v) => {
            const classes = sanitizeClasses(v)
            const { instanceId: iid, sourceId: sid } = parsePathId(pathIds[0])
            if (iid && iid !== pathIds[0]) {
              setInstanceOverride({ store: editorStore }, iid, sid, { classes })
            } else {
              editorStore.apply('Edit classes', [{ t: 'setClasses', id: sid, classes }])
            }
          }}
        />
      </Section>
      <Section title="Filters">
        <FieldLabel>Filter</FieldLabel>
        <TextField value={s.filter ?? ''} placeholder="blur(4px) saturate(1.2)…" mono
          onCommit={(v) => write({ filter: v || null })} />
        <FieldLabel>Backdrop filter</FieldLabel>
        <TextField value={s['backdrop-filter'] ?? ''} placeholder="blur(8px)…" mono
          onCommit={(v) => write({ 'backdrop-filter': v || null })} />
      </Section>
      <Section title="Inline styles">
        {Object.keys(s).length === 0 ? (
          <div className="text-[10px] text-[var(--cz-panel-muted)]">No inline styles.</div>
        ) : (
          <pre className="select-text overflow-x-auto rounded-md bg-[var(--cz-panel-hover)] p-2 font-mono text-[10px] leading-relaxed text-[var(--cz-panel-fg)]">
            {Object.entries(s).map(([k, v]) => `${k}: ${v};`).join('\n')}
          </pre>
        )}
      </Section>
    </>
  )
}

function TextSection({ s, write }: { s: Record<string, string>; write: StyleWrite }) {
  return (
    <Section title="Text">
      <FieldLabel>Font</FieldLabel>
      <FontFamilyField value={s['font-family'] ?? ''} onCommit={(v) => write({ 'font-family': v || null })} />
      <Row>
        <SelectField
          value={s['font-weight'] ?? '400'}
          options={[
            { value: '300', label: 'Light' },
            { value: '400', label: 'Regular' },
            { value: '500', label: 'Medium' },
            { value: '600', label: 'Semibold' },
            { value: '700', label: 'Bold' },
            { value: '800', label: 'Extrabold' },
          ]}
          onCommit={(v) => write({ 'font-weight': v === '400' ? null : v })}
        />
        <NumberField
          label={<Icon name="textformat.size" size={12} />}
          title="Font size"
          value={px(s['font-size']) ?? 16} min={1}
          onCommit={(v, o) => write({ 'font-size': `${v}px` }, undefined, o)}
        />
      </Row>
      <FieldLabel>Color</FieldLabel>
      <ColorField value={s.color ?? ''} allowEmpty onCommit={(v, o) => write({ color: v }, undefined, o)} />
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>Line Height</FieldLabel>
          <NumberField
            label={<Icon name="arrow.up.and.down" size={12} />}
            title="Line height"
            value={s['line-height'] ? parseFloat(s['line-height']) || null : null}
            step={0.1}
            unit=""
            onCommit={(v, o) => write({ 'line-height': String(v) }, undefined, o)}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>Letter Spacing</FieldLabel>
          <NumberField
            label={<Icon name="arrow.left.and.right" size={12} />}
            title="Letter spacing"
            value={letterSpacingPct(s)}
            step={0.5}
            unit="%"
            onCommit={(v, o) =>
              write({ 'letter-spacing': v === 0 ? null : `${Math.round(v * 100) / 10000}em` }, undefined, o)
            }
          />
        </div>
      </div>
      <FieldLabel>Alignment</FieldLabel>
      <Row>
        <IconRow
          ariaLabel="Text align"
          value={(s['text-align'] as 'left' | 'center' | 'right' | 'justify' | undefined) ?? 'left'}
          options={[
            { value: 'left', icon: <Icon name="text.alignleft" size={14} />, label: 'Align left' },
            { value: 'center', icon: <Icon name="text.aligncenter" size={14} />, label: 'Align center' },
            { value: 'right', icon: <Icon name="text.alignright" size={14} />, label: 'Align right' },
            { value: 'justify', icon: <Icon name="text.justify" size={14} />, label: 'Justify' },
          ]}
          onChange={(v) => write({ 'text-align': v === 'left' ? null : v })}
        />
        <IconRow
          ariaLabel="Vertical align"
          value={s['align-content'] === 'center' ? 'center' : s['align-content'] === 'end' ? 'end' : 'start'}
          options={[
            { value: 'start', icon: <Icon name="arrow.up.to.line" size={14} />, label: 'Align top' },
            { value: 'center', icon: <Icon name="align.vertical.center" size={14} />, label: 'Align middle' },
            { value: 'end', icon: <Icon name="arrow.down.to.line" size={14} />, label: 'Align bottom' },
          ]}
          onChange={(v) => write({ 'align-content': v === 'start' ? null : v })}
        />
      </Row>
    </Section>
  )
}

/** Letter spacing displayed as % of font size (Figma-style). */
function letterSpacingPct(s: Record<string, string>): number {
  const raw = s['letter-spacing']
  if (!raw) return 0
  const fontSize = px(s['font-size']) ?? 16
  const n = parseFloat(raw)
  if (Number.isNaN(n)) return 0
  if (raw.endsWith('em')) return Math.round(n * 10000) / 100
  if (raw.endsWith('px')) return Math.round((n / fontSize) * 10000) / 100
  return 0
}

const FONT_STACKS = [
  'Inter', 'system-ui', 'Arial', 'Helvetica Neue', 'Georgia',
  'Times New Roman', 'Courier New', 'Menlo',
]

function FontFamilyField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const docFonts = Object.keys(editorStore.doc.fonts ?? {}).map((f) => `'${f}', sans-serif`)
  const known = [...docFonts, ...FONT_STACKS]
  const options = [
    { value: '', label: 'Default' },
    ...docFonts.map((f, i) => ({ value: f, label: Object.keys(editorStore.doc.fonts)[i] })),
    ...FONT_STACKS.map((f) => ({ value: f, label: f })),
    ...(value && !known.includes(value) ? [{ value, label: value }] : []),
  ]
  return <SelectField value={value} options={options} onCommit={onCommit} />
}

function BackgroundSection({ s, write, node, sourceId }: {
  s: Record<string, string>
  write: StyleWrite
  node: NodeModel
  sourceId: NodeId
}) {
  const color = s['background-color'] ?? ''
  const image = s['background-image'] ?? s.background ?? ''
  const empty = !color && !image && node.tag !== 'img'
  return (
    <Section
      title="Background"
      actions={
        !color || !image ? (
          <IconButton
            label="Add fill"
            onClick={() => {
              if (!color) write({ 'background-color': '#ffffff' }, 'Add fill')
              else write({ 'background-image': 'linear-gradient(180deg, #ffffff 0%, #d6d6d6 100%)' }, 'Add fill')
            }}
          >
            <Icon name="plus" size={12} />
          </IconButton>
        ) : undefined
      }
    >
      {empty ? (
        <div className="text-[10px] text-[var(--cz-panel-muted)]">No fill — add one with +.</div>
      ) : null}
      {color ? (
        <>
          <FieldLabel>Solid</FieldLabel>
          <ColorField value={color} allowEmpty onCommit={(v, o) => write({ 'background-color': v }, undefined, o)} />
        </>
      ) : null}
      {image ? (
        <>
          <FieldLabel
            action={
              <IconButton label="Remove" onClick={() => write({ 'background-image': null, background: null })}>
                <Icon name="minus" size={11} />
              </IconButton>
            }
          >
            Gradient / Image
          </FieldLabel>
          <TextField
            value={image}
            placeholder="linear-gradient(…) / url(…)"
            onCommit={(v) => write({ 'background-image': v || null })}
            mono
          />
        </>
      ) : null}
      {node.tag === 'img' ? (
        <>
          <FieldLabel>Image source</FieldLabel>
          <TextField
            value={node.attrs.src ?? ''}
            placeholder="https://image url"
            mono
            onCommit={(v) => {
              const safe = sanitizeUrl(v)
              if (safe) editorStore.apply('Set image', [{ t: 'setAttrs', id: sourceId, set: { src: safe } }])
            }}
          />
        </>
      ) : null}
    </Section>
  )
}

const BORDER_SIDES = ['all', 'top', 'right', 'bottom', 'left'] as const

function BorderSection({ s, write }: { s: Record<string, string>; write: StyleWrite }) {
  const [side, setSide] = useState<(typeof BORDER_SIDES)[number]>('all')
  const prop = (suffix: string) => (side === 'all' ? `border-${suffix}` : `border-${side}-${suffix}`)
  const has = Boolean(
    s.border || s['border-width'] || s['border-color'] ||
    BORDER_SIDES.some((sd) => s[`border-${sd}-width`]),
  )
  const width = px(s[prop('width')])
  return (
    <Section
      title="Border"
      actions={
        !has ? (
          <IconButton
            label="Add border"
            onClick={() => write({ 'border-width': '1px', 'border-style': 'solid', 'border-color': '#000000' }, 'Add border')}
          >
            <Icon name="plus" size={12} />
          </IconButton>
        ) : (
          <IconButton
            label="Remove border"
            onClick={() =>
              write({
                border: null, 'border-width': null, 'border-style': null, 'border-color': null,
                'border-top-width': null, 'border-right-width': null,
                'border-bottom-width': null, 'border-left-width': null,
              }, 'Remove border')
            }
          >
            <Icon name="minus" size={11} />
          </IconButton>
        )
      }
    >
      {has ? (
        <>
          <SelectField
            value={s[prop('style')] ?? 'solid'}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
              { value: 'dotted', label: 'Dotted' },
            ]}
            onCommit={(v) => write({ [prop('style')]: v })}
          />
          <ColorField
            value={s[prop('color')] ?? ''}
            allowEmpty
            onCommit={(v, o) => write({ [prop('color')]: v }, undefined, o)}
          />
          <FieldLabel>Weight</FieldLabel>
          <Row>
            <NumberField
              label={<Icon name="line.3.horizontal" size={12} />}
              title="Border weight"
              value={width ?? (s.border || s[prop('width')] ? null : 0)}
              min={0}
              onCommit={(v, o) =>
                write({ [prop('width')]: `${v}px`, [prop('style')]: s[prop('style')] ?? 'solid' }, undefined, o)
              }
            />
            <SelectField
              value={side}
              options={BORDER_SIDES.map((v) => ({ value: v, label: v === 'all' ? 'All sides' : v[0].toUpperCase() + v.slice(1) }))}
              onCommit={(v) => setSide(v as (typeof BORDER_SIDES)[number])}
            />
          </Row>
        </>
      ) : (
        <div className="text-[10px] text-[var(--cz-panel-muted)]">No border — add one with +.</div>
      )}
    </Section>
  )
}

// --- Shadow & Blur ----------------------------------------------------------

interface ShadowModel {
  inset: boolean
  x: number
  y: number
  blur: number
  spread: number
  color: string
}

/** Split a box-shadow list on top-level commas (not inside rgba(...)). */
function splitShadows(raw: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

const SHADOW_PART_RE =
  /^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)px)?(?:\s+(-?[\d.]+)px)?\s*(.*)$/

function parseShadow(part: string): ShadowModel | null {
  let rest = part.trim()
  let inset = false
  if (/^inset\b/i.test(rest)) {
    inset = true
    rest = rest.replace(/^inset\s+/i, '')
  } else if (/\binset$/i.test(rest)) {
    inset = true
    rest = rest.replace(/\s+inset$/i, '')
  }
  const m = SHADOW_PART_RE.exec(rest)
  if (!m) return null
  return {
    inset,
    x: +m[1],
    y: +m[2],
    blur: m[3] ? +m[3] : 0,
    spread: m[4] ? +m[4] : 0,
    color: m[5]?.trim() || 'rgba(0,0,0,0.25)',
  }
}

function serializeShadow(sh: ShadowModel): string {
  return `${sh.inset ? 'inset ' : ''}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${sh.color}`
}

/** Parse `blur(Npx)` (and nothing else) out of a filter value. */
function blurRadius(value: string | undefined): number | null {
  if (!value) return null
  const m = /^blur\(\s*(-?[\d.]+)px\s*\)$/.exec(value.trim())
  return m ? +m[1] : null
}

function EffectsSection({ s, write }: { s: Record<string, string>; write: StyleWrite }) {
  const raw = (s['box-shadow'] ?? '').trim()
  const parts = raw ? splitShadows(raw) : []
  const shadows = parts.map(parseShadow)
  const structured = shadows.every((sh) => sh !== null)
  const layerBlur = blurRadius(s.filter)
  const backdropBlur = blurRadius(s['backdrop-filter'])
  const hasAny = parts.length > 0 || layerBlur !== null || backdropBlur !== null

  const setShadow = (index: number, patch: Partial<ShadowModel>, opts?: CommitOpts) => {
    const next = (shadows as ShadowModel[]).map((sh, i) => (i === index ? { ...sh, ...patch } : sh))
    write({ 'box-shadow': next.map(serializeShadow).join(', ') }, 'Edit shadow', opts)
  }
  const removeShadow = (index: number) => {
    const next = (shadows as ShadowModel[]).filter((_, i) => i !== index)
    write({ 'box-shadow': next.length > 0 ? next.map(serializeShadow).join(', ') : null }, 'Remove shadow')
  }
  const addShadow = (inset: boolean) => {
    const sh: ShadowModel = inset
      ? { inset: true, x: 0, y: 2, blur: 4, spread: 0, color: 'rgba(0,0,0,0.25)' }
      : { inset: false, x: 0, y: 2, blur: 8, spread: 0, color: 'rgba(0,0,0,0.25)' }
    const list = structured ? [...(shadows as ShadowModel[]), sh] : [sh]
    write({ 'box-shadow': list.map(serializeShadow).join(', ') }, 'Add shadow')
  }

  return (
    <Section
      title="Shadow & Blur"
      collapsible={!hasAny}
      defaultOpen={hasAny}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add effect"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)] hover:text-white"
            >
              <Icon name="plus" size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="cz-panel min-w-[9rem] border-[var(--cz-panel-border)] p-1 text-[12px]"
          >
            <DropdownMenuItem className="rounded px-2 py-1 text-[12px] focus:bg-[var(--cz-panel-hover)]"
              onSelect={() => addShadow(false)}>
              Drop shadow
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded px-2 py-1 text-[12px] focus:bg-[var(--cz-panel-hover)]"
              onSelect={() => addShadow(true)}>
              Inner shadow
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded px-2 py-1 text-[12px] focus:bg-[var(--cz-panel-hover)]"
              disabled={Boolean(s.filter) && layerBlur === null}
              onSelect={() => write({ filter: 'blur(4px)' }, 'Add layer blur')}>
              Layer blur
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded px-2 py-1 text-[12px] focus:bg-[var(--cz-panel-hover)]"
              disabled={Boolean(s['backdrop-filter']) && backdropBlur === null}
              onSelect={() => write({ 'backdrop-filter': 'blur(8px)' }, 'Add backdrop blur')}>
              Backdrop blur
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {!hasAny ? (
        <div className="text-[10px] text-[var(--cz-panel-muted)]">No effects — add one with +.</div>
      ) : null}
      {structured ? (
        (shadows as ShadowModel[]).map((sh, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-md border border-[var(--cz-panel-border)] p-1.5">
            <div className="flex items-center gap-1">
              <SelectField
                value={sh.inset ? 'inner' : 'drop'}
                options={[
                  { value: 'drop', label: 'Drop shadow' },
                  { value: 'inner', label: 'Inner shadow' },
                ]}
                onCommit={(v) => setShadow(i, { inset: v === 'inner' })}
              />
              <IconButton label="Remove effect" onClick={() => removeShadow(i)}>
                <Icon name="minus" size={11} />
              </IconButton>
            </div>
            <Row>
              <NumberField label="X" title="Shadow X" unit="" value={sh.x}
                onCommit={(v, o) => setShadow(i, { x: v }, o)} />
              <NumberField label="Y" title="Shadow Y" unit="" value={sh.y}
                onCommit={(v, o) => setShadow(i, { y: v }, o)} />
              <NumberField label="B" title="Shadow blur" unit="" value={sh.blur} min={0}
                onCommit={(v, o) => setShadow(i, { blur: v }, o)} />
              <NumberField label="S" title="Shadow spread" unit="" value={sh.spread}
                onCommit={(v, o) => setShadow(i, { spread: v }, o)} />
            </Row>
            <ColorField value={sh.color} onCommit={(v, o) => (v ? setShadow(i, { color: v }, o) : removeShadow(i))} />
          </div>
        ))
      ) : raw ? (
        <TextField value={raw} mono placeholder="box shadow…"
          onCommit={(v) => write({ 'box-shadow': v || null })} />
      ) : null}
      {layerBlur !== null ? (
        <Row>
          <NumberField
            label={<Icon name="drop" size={12} />}
            title="Layer blur"
            value={layerBlur} min={0}
            onCommit={(v, o) => write({ filter: v === 0 ? null : `blur(${v}px)` }, 'Layer blur', o)}
          />
          <IconButton label="Remove layer blur" onClick={() => write({ filter: null }, 'Remove layer blur')}>
            <Icon name="minus" size={11} />
          </IconButton>
        </Row>
      ) : null}
      {backdropBlur !== null ? (
        <Row>
          <NumberField
            label={<Icon name="drop.halffull" size={12} />}
            title="Backdrop blur"
            value={backdropBlur} min={0}
            onCommit={(v, o) => write({ 'backdrop-filter': v === 0 ? null : `blur(${v}px)` }, 'Backdrop blur', o)}
          />
          <IconButton label="Remove backdrop blur" onClick={() => write({ 'backdrop-filter': null }, 'Remove backdrop blur')}>
            <Icon name="minus" size={11} />
          </IconButton>
        </Row>
      ) : null}
    </Section>
  )
}

/** Node identity: the stable id AI tools and exports reference. */
function PropertiesSection({ sourceId }: { sourceId: NodeId }) {
  const [copied, setCopied] = useState(false)
  return (
    <Section title="Properties">
      <div className="flex items-center gap-1.5">
        <span className="w-6 shrink-0 text-[10px] text-[var(--cz-panel-muted)]">ID</span>
        <span className="min-w-0 flex-1 truncate rounded-md bg-[var(--cz-panel-hover)] px-2 py-1 font-mono text-[10.5px] text-[var(--cz-panel-fg)]">
          {sourceId}
        </span>
        <IconButton
          label={copied ? 'Copied!' : 'Copy ID'}
          onClick={() => {
            void navigator.clipboard?.writeText(sourceId).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          <Icon name="document.on.document" size={11} />
        </IconButton>
      </div>
    </Section>
  )
}

/** Swap the SF Symbol on a selected vector by free-text Apple name. */
function IconSection({ sourceId, node }: { sourceId: NodeId; node: NodeModel }) {
  const current = node.attrs['data-cz-icon'] ?? ''
  const variant = (node.attrs['data-cz-variant'] as 'monochrome' | 'dualtone' | undefined) ?? 'monochrome'
  const [draft, setDraft] = useState(current)

  const swap = (name: string, nextVariant: 'monochrome' | 'dualtone') => {
    const trimmed = name.trim()
    if (!trimmed) return
    void replaceNodeWithIcon({ store: editorStore }, sourceId, trimmed, { variant: nextVariant }).then((id) => {
      if (id) editorStore.setSelection([id])
    })
  }

  return (
    <Section title="Icon">
      <Row>
        <TextField
          value={draft}
          placeholder="SF Symbol, e.g. heart.fill"
          onCommit={(v) => {
            setDraft(v)
            swap(v, variant)
          }}
        />
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded bg-[var(--cz-panel-hover)] text-[var(--cz-panel-fg)]"
          title="Preview"
        >
          <SFSymbol name={(draft || current || 'questionmark').trim()} variant={variant} size={16} />
        </span>
      </Row>
      <SelectField
        label="Variant"
        value={variant}
        options={[
          { value: 'monochrome', label: 'Monochrome' },
          { value: 'dualtone', label: 'Dualtone' },
        ]}
        onCommit={(v) => swap(current || draft, v as 'monochrome' | 'dualtone')}
      />
      {!current ? (
        <div className="text-[10px] text-[var(--cz-panel-muted)]">
          Type an Apple symbol name to turn this vector into an SF Symbol.
        </div>
      ) : null}
    </Section>
  )
}

interface PropSlot {
  key: NodeId
  label: string
  kind: 'text' | 'icon'
  value: string
  visible: boolean
}

/** Editable prop slots of an instance: text leaves and icon vectors of the
 * effective (variant-aware) definition, keyed by canonical ids so edits
 * apply across every variant. */
function collectPropSlots(instanceId: NodeId): PropSlot[] {
  const doc = editorStore.doc
  const instance = doc.nodes[instanceId]
  const rootId = instance ? effectiveComponentRoot(doc, instance) : null
  const slots: PropSlot[] = []
  const walk = (id: NodeId, depth: number) => {
    if (slots.length >= 12 || depth > 6) return
    const n = doc.nodes[id]
    if (!n || n.componentId) return
    const key = n.refId ?? n.id
    const ov = instance?.overrides?.[key]
    if (n.tag === 'svg' && n.attrs['data-cz-icon']) {
      slots.push({
        key, label: n.name, kind: 'icon',
        value: ov?.attrs?.['data-cz-icon'] ?? n.attrs['data-cz-icon'],
        visible: ov?.visible ?? n.visible,
      })
    } else if (n.text !== undefined) {
      slots.push({ key, label: n.name, kind: 'text', value: ov?.text ?? n.text, visible: ov?.visible ?? n.visible })
    }
    n.children.forEach((c) => walk(c, depth + 1))
  }
  if (rootId) doc.nodes[rootId]?.children.forEach((c) => walk(c, 1))
  return slots
}

function PropRow({ instanceId, slot }: { instanceId: NodeId; slot: PropSlot }) {
  const write = (patch: Parameters<typeof setInstanceOverride>[3]) =>
    setInstanceOverride({ store: editorStore }, instanceId, slot.key, patch)
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 truncate text-[10px] text-[var(--cz-panel-muted)]" title={slot.label}>
        {slot.label}
      </span>
      <TextField
        value={slot.value}
        mono={slot.kind === 'icon'}
        onCommit={(v) =>
          write(slot.kind === 'text' ? { text: v } : { attrs: { 'data-cz-icon': v.trim() } })
        }
      />
      {slot.kind === 'icon' ? (
        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-[var(--cz-panel-hover)]">
          <SFSymbol name={slot.value} variant="monochrome" size={12} />
        </span>
      ) : null}
      <button
        type="button"
        aria-label={slot.visible ? `Hide ${slot.label}` : `Show ${slot.label}`}
        className="shrink-0 p-0.5 text-[var(--cz-panel-muted)] hover:text-white"
        onClick={() => write({ visible: !slot.visible })}
      >
        {slot.visible ? <Icon name="eye" size={12} /> : <Icon name="eye.slash" size={12} />}
      </button>
    </div>
  )
}

function ComponentSection({ instanceId, componentId, variantId }: {
  instanceId: NodeId
  componentId: string
  variantId?: string
}) {
  const def = editorStore.doc.components[componentId]
  const variants = variantsOf(editorStore, componentId)
  const slots = collectPropSlots(instanceId)
  if (!def) return null
  return (
    <Section
      title="Instance"
      actions={
        <Button
          variant="ghost"
          className="h-5 px-1.5 text-[10px] text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)]"
          onClick={() => detachInstance({ store: editorStore }, instanceId)}
        >
          Detach
        </Button>
      }
    >
      <div className="text-[10px] text-[var(--cz-ai)]">⬦ {def.name}</div>
      {variants.length > 1 ? (
        <SelectField
          label="Variant"
          value={variantId ?? componentId}
          options={variants.map((v) => ({
            value: v.id,
            label: v.variantProps?.variant ?? v.name,
          }))}
          onCommit={(v) => setInstanceVariant({ store: editorStore }, instanceId, v)}
        />
      ) : null}
      {slots.length > 0 ? (
        <>
          <div className="pt-1 text-[10px] text-[var(--cz-panel-muted)]">Props</div>
          {slots.map((slot) => (
            <PropRow key={slot.key + slot.kind} instanceId={instanceId} slot={slot} />
          ))}
        </>
      ) : null}
      {editorStore.doc.nodes[instanceId]?.overrides &&
      Object.keys(editorStore.doc.nodes[instanceId].overrides ?? {}).length > 0 ? (
        <Button
          variant="ghost"
          className="h-5 justify-start px-1.5 text-[10px] text-[var(--cz-panel-muted)] hover:bg-[var(--cz-panel-hover)]"
          onClick={() => {
            const overrides = editorStore.doc.nodes[instanceId]?.overrides ?? {}
            editorStore.apply('Reset overrides', Object.keys(overrides).map((sid) => ({
              t: 'setOverride' as const, id: instanceId, sourceId: sid, patch: null,
            })))
          }}
        >
          Reset overrides ({Object.keys(editorStore.doc.nodes[instanceId]?.overrides ?? {}).length})
        </Button>
      ) : null}
    </Section>
  )
}

function ExportSection({ pathId }: { pathId: string }) {
  const [copied, setCopied] = useState<'html' | 'jsx' | null>(null)
  const { sourceId } = parsePathId(pathId)
  const copy = (kind: 'html' | 'jsx') => {
    const code = kind === 'html'
      ? exportHtml(editorStore.doc, sourceId)
      : exportJsx(editorStore.doc, sourceId)
    void navigator.clipboard?.writeText(code).catch(() => {})
    setCopied(kind)
    setTimeout(() => setCopied(null), 1200)
  }
  return (
    <Section title="Export">
      <Row>
        <Button
          variant="ghost"
          data-testid="export-html"
          className="h-6 flex-1 bg-[var(--cz-panel-hover)] text-[11px] hover:bg-[var(--cz-panel-active)] hover:text-white"
          onClick={() => copy('html')}
        >
          {copied === 'html' ? 'Copied!' : 'Copy HTML'}
        </Button>
        <Button
          variant="ghost"
          data-testid="export-jsx"
          className="h-6 flex-1 bg-[var(--cz-panel-hover)] text-[11px] hover:bg-[var(--cz-panel-active)] hover:text-white"
          onClick={() => copy('jsx')}
        >
          {copied === 'jsx' ? 'Copied!' : 'Copy JSX'}
        </Button>
      </Row>
    </Section>
  )
}
