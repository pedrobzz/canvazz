import { useRef, useState } from 'react'
import {
  AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal,
  AlignEndVertical, AlignJustify, AlignLeft, AlignRight, AlignStartHorizontal,
  AlignStartVertical, ArrowDown, ArrowLeftRight, ArrowRight, ArrowUpDown,
  MoveHorizontal, MoveVertical, UnfoldHorizontal, UnfoldVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { exportHtml, exportJsx } from '../compiler/export'
import { isAllowedCssProp, isSafeCssValue, sanitizeClasses, sanitizeUrl } from '../compiler/allowlist'
import { controllerRef } from '../canvas/CanvasRoot'
import { px, fmtPx } from '../canvas/geometry'
import { effectiveComponentRoot, parsePathId, stripPlacement } from '../model/instances'
import {
  createMainComponent, detachInstance, setInstanceOverride, setInstanceVariant, variantsOf,
} from '../components/componentCommands'
import { renameNode } from '../commands'
import { editorStore } from '../store/editorStore'
import { useDocVersion, useUi } from '../store/hooks'
import {
  ActionRow, AlignmentGrid, ColorField, IconRow, NumberField, Row, Section,
  SelectField, SizeField, TextField,
} from './fields'
import type { SizeMode } from './fields'
import type { NodeId, NodeModel, Op } from '../model/types'

/**
 * Right-hand inspector. Sections adapt to the selection type and write
 * straight to the model (one transaction per commit). Selecting inside a
 * component instance writes overrides instead of touching the definition.
 * The panel is resizable and never scrolls horizontally.
 */

function writeStyle(pathIds: string[], set: Record<string, string | null>, label = 'Edit style') {
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
      const instance = editorStore.doc.nodes[instanceId]
      const prev = instance?.overrides?.[sourceId]?.style ?? {}
      const style = { ...prev }
      for (const [k, v] of Object.entries(safe)) {
        if (v === null) delete style[k]
        else style[k] = v
      }
      ops.push({ t: 'setOverride', id: instanceId, sourceId, patch: { style } })
    } else {
      ops.push({ t: 'setStyle', id: sourceId, set: safe })
    }
  }
  editorStore.apply(label, ops)
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
  const override = editorStore.doc.nodes[instanceId]?.overrides?.[sourceId]
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

  const write = (set: Record<string, string | null>, label?: string) => writeStyle(pathIds, set, label)
  const writeNum = (prop: string, unit = 'px') => (v: number) => write({ [prop]: `${v}${unit}` })

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

  const applySizeFixed = (axis: 'w' | 'h') => (raw: string) => {
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
    write(set, 'Resize')
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
  const writePair = (props: [string, string], shorthand: string, keepProps: [string, string]) => (v: number) => {
    const keep = px(s[keepProps[0]] ?? s[shorthand])
    const set: Record<string, string | null> = {
      [props[0]]: `${v}px`, [props[1]]: `${v}px`, [shorthand]: null,
    }
    if (keep !== null) {
      set[keepProps[0]] = `${keep}px`
      set[keepProps[1]] = `${keep}px`
    }
    return write(set)
  }

  return (
    <>
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

      <Section title="Position">
        {isAbsolute ? (
          <ActionRow
            actions={[
              { icon: <AlignStartHorizontal className="size-3.5" />, label: 'Align left', onClick: () => alignInParent(pathIds, 'left') },
              { icon: <AlignCenterHorizontal className="size-3.5" />, label: 'Align horizontal centers', onClick: () => alignInParent(pathIds, 'hcenter') },
              { icon: <AlignEndHorizontal className="size-3.5" />, label: 'Align right', onClick: () => alignInParent(pathIds, 'right') },
              { icon: <AlignStartVertical className="size-3.5" />, label: 'Align top', onClick: () => alignInParent(pathIds, 'top') },
              { icon: <AlignCenterVertical className="size-3.5" />, label: 'Align vertical centers', onClick: () => alignInParent(pathIds, 'vcenter') },
              { icon: <AlignEndVertical className="size-3.5" />, label: 'Align bottom', onClick: () => alignInParent(pathIds, 'bottom') },
            ]}
          />
        ) : null}
        <Row>
          <NumberField label="X" value={px(s.left)} onCommit={writeNum('left')} disabled={!isAbsolute} />
          <NumberField label="Y" value={px(s.top)} onCommit={writeNum('top')} disabled={!isAbsolute} />
        </Row>
        <Row>
          <NumberField
            label="∠"
            value={s.rotate ? parseFloat(s.rotate) || 0 : 0}
            unit="deg"
            onCommit={(v) => write({ rotate: v === 0 ? null : `${v}deg` })}
          />
          <SelectField
            value={s.position ?? 'static'}
            options={[
              { value: 'absolute', label: 'Absolute' },
              { value: 'static', label: 'In layout' },
              { value: 'relative', label: 'Relative' },
            ]}
            onCommit={(v) => write(v === 'static' ? { position: null, left: null, top: null } : { position: v })}
          />
        </Row>
      </Section>

      <Section title="Layout">
        <Row>
          <SizeField label="W" {...sizeOf('w')} onFixed={applySizeFixed('w')} onMode={applySizeMode('w')} />
          <SizeField label="H" {...sizeOf('h')} onFixed={applySizeFixed('h')} onMode={applySizeMode('h')} />
        </Row>
        {isContainer ? (
          <>
            <SelectField
              label="Type"
              value={s.display ?? 'block'}
              options={[
                { value: 'block', label: 'Free (block)' },
                { value: 'flex', label: 'Auto layout (flex)' },
                { value: 'grid', label: 'Grid' },
                { value: 'none', label: 'None' },
              ]}
              onCommit={(v) => write({ display: v === 'block' ? null : v })}
            />
            {s.display === 'flex' ? (
              <>
                <Row>
                  <IconRow
                    ariaLabel="Flex direction"
                    value={(s['flex-direction'] ?? 'row').startsWith('column') ? 'column' : 'row'}
                    options={[
                      { value: 'row', icon: <ArrowRight className="size-3.5" />, label: 'Horizontal' },
                      { value: 'column', icon: <ArrowDown className="size-3.5" />, label: 'Vertical' },
                    ]}
                    onChange={(v) => write({ 'flex-direction': v === 'row' ? null : v })}
                  />
                  <SelectField
                    value={s['flex-wrap'] ?? 'nowrap'}
                    options={[
                      { value: 'nowrap', label: 'No wrap' },
                      { value: 'wrap', label: 'Wrap' },
                    ]}
                    onCommit={(v) => write({ 'flex-wrap': v === 'nowrap' ? null : v })}
                  />
                </Row>
                <Row>
                  <AlignmentGrid
                    direction={(s['flex-direction'] ?? 'row').startsWith('column') ? 'column' : 'row'}
                    justify={s['justify-content'] ?? ''}
                    align={s['align-items'] ?? ''}
                    onChange={(j, a) =>
                      write({ 'justify-content': j === 'flex-start' ? null : j, 'align-items': a })
                    }
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <NumberField
                      label={<UnfoldHorizontal className="size-3" aria-label="Horizontal gap" />}
                      value={px(s['column-gap'] ?? s.gap) ?? 0}
                      min={0}
                      onCommit={(v) => {
                        const rowGap = px(s['row-gap'] ?? s.gap)
                        write({ 'column-gap': `${v}px`, 'row-gap': rowGap !== null ? `${rowGap}px` : `${v}px`, gap: null })
                      }}
                    />
                    <NumberField
                      label={<UnfoldVertical className="size-3" aria-label="Vertical gap" />}
                      value={px(s['row-gap'] ?? s.gap) ?? 0}
                      min={0}
                      onCommit={(v) => {
                        const colGap = px(s['column-gap'] ?? s.gap)
                        write({ 'row-gap': `${v}px`, 'column-gap': colGap !== null ? `${colGap}px` : `${v}px`, gap: null })
                      }}
                    />
                  </div>
                </Row>
              </>
            ) : null}
            <div className="text-[10px] text-[var(--cz-panel-muted)]">Padding</div>
            <Row>
              <NumberField
                label={<ArrowLeftRight className="size-3" aria-label="Horizontal padding" />}
                value={px(s['padding-left'] ?? s.padding) ?? 0}
                min={0}
                onCommit={writePair(['padding-left', 'padding-right'], 'padding', ['padding-top', 'padding-bottom'])}
              />
              <NumberField
                label={<ArrowUpDown className="size-3" aria-label="Vertical padding" />}
                value={px(s['padding-top'] ?? s.padding) ?? 0}
                min={0}
                onCommit={writePair(['padding-top', 'padding-bottom'], 'padding', ['padding-left', 'padding-right'])}
              />
            </Row>
            <SelectField
              value={s.overflow ?? 'visible'}
              options={[
                { value: 'visible', label: 'Show overflow' },
                { value: 'hidden', label: 'Clip content' },
                { value: 'auto', label: 'Scroll' },
              ]}
              onCommit={(v) => write({ overflow: v === 'visible' ? null : v })}
            />
          </>
        ) : null}
        {flowChild ? (
          <>
            <div className="text-[10px] text-[var(--cz-panel-muted)]">Margin</div>
            <Row>
              <NumberField
                label={<MoveHorizontal className="size-3" aria-label="Horizontal margin" />}
                value={px(s['margin-left'] ?? s.margin) ?? 0}
                min={0}
                onCommit={writePair(['margin-left', 'margin-right'], 'margin', ['margin-top', 'margin-bottom'])}
              />
              <NumberField
                label={<MoveVertical className="size-3" aria-label="Vertical margin" />}
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
      </Section>

      <Section title="Appearance">
        <Row>
          <NumberField
            label="Op"
            value={s.opacity ? Math.round(parseFloat(s.opacity) * 100) : 100}
            min={0}
            unit="%"
            onCommit={(v) => write({ opacity: v >= 100 ? null : String(Math.max(0, Math.min(100, v)) / 100) })}
          />
          <NumberField
            label="◜"
            value={px(s['border-radius']) ?? (s['border-radius'] ? null : 0)}
            min={0}
            onCommit={writeNum('border-radius')}
          />
        </Row>
        <label className="flex items-center justify-between text-[11px] text-[var(--cz-panel-fg)]">
          Clip content
          <Switch
            checked={s.overflow === 'hidden'}
            onCheckedChange={(checked) => write({ overflow: checked ? 'hidden' : null })}
          />
        </label>
        <SelectField
          label="Blend"
          value={s['mix-blend-mode'] ?? 'normal'}
          options={['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'].map((v) => ({
            value: v, label: v,
          }))}
          onCommit={(v) => write({ 'mix-blend-mode': v === 'normal' ? null : v })}
        />
      </Section>

      <Section title="Fill">
        <ColorField
          label="Color"
          value={s['background-color'] ?? ''}
          allowEmpty
          onCommit={(v) => write({ 'background-color': v })}
        />
        <TextField
          value={s['background-image'] ?? s.background ?? ''}
          placeholder="gradient / image…"
          onCommit={(v) => write({ 'background-image': v || null })}
          mono
        />
        {node.tag === 'img' ? (
          <TextField
            value={node.attrs.src ?? ''}
            placeholder="https://image url"
            mono
            onCommit={(v) => {
              const safe = sanitizeUrl(v)
              if (safe) editorStore.apply('Set image', [{ t: 'setAttrs', id: sourceId, set: { src: safe } }])
            }}
          />
        ) : null}
      </Section>

      <Section title="Border">
        <Row>
          <NumberField
            label="W"
            value={px(s['border-width']) ?? (s.border ? null : 0)}
            min={0}
            onCommit={(v) =>
              write(v === 0
                ? { border: null, 'border-width': null, 'border-style': null }
                : { 'border-width': `${v}px`, 'border-style': s['border-style'] ?? 'solid' })
            }
          />
          <SelectField
            value={s['border-style'] ?? 'solid'}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
              { value: 'dotted', label: 'Dotted' },
            ]}
            onCommit={(v) => write({ 'border-style': v })}
          />
        </Row>
        <ColorField
          label="Color"
          value={s['border-color'] ?? ''}
          allowEmpty
          onCommit={(v) => write({ 'border-color': v })}
        />
      </Section>

      {isText ? (
        <Section title="Typography">
          <TextField
            value={s['font-family'] ?? ''}
            placeholder="font family"
            onCommit={(v) => write({ 'font-family': v || null })}
          />
          <Row>
            <NumberField label="Size" value={px(s['font-size']) ?? 16} min={1} onCommit={writeNum('font-size')} />
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
          </Row>
          <Row>
            <NumberField
              label="LH"
              value={s['line-height'] ? parseFloat(s['line-height']) || null : null}
              step={0.1}
              unit=""
              onCommit={(v) => write({ 'line-height': String(v) })}
            />
            <NumberField
              label="LS"
              value={px(s['letter-spacing']) ?? 0}
              step={0.1}
              onCommit={(v) => write({ 'letter-spacing': v === 0 ? null : `${v}px` })}
            />
          </Row>
          <Row>
            <IconRow
              ariaLabel="Text align"
              value={(s['text-align'] as 'left' | 'center' | 'right' | 'justify' | undefined) ?? 'left'}
              options={[
                { value: 'left', icon: <AlignLeft className="size-3.5" />, label: 'Left' },
                { value: 'center', icon: <AlignCenter className="size-3.5" />, label: 'Center' },
                { value: 'right', icon: <AlignRight className="size-3.5" />, label: 'Right' },
                { value: 'justify', icon: <AlignJustify className="size-3.5" />, label: 'Justify' },
              ]}
              onChange={(v) => write({ 'text-align': v === 'left' ? null : v })}
            />
          </Row>
          <ColorField label="Color" value={s.color ?? ''} allowEmpty onCommit={(v) => write({ color: v })} />
        </Section>
      ) : null}

      <Section title="Effects">
        <TextField
          value={s['box-shadow'] ?? ''}
          placeholder="box shadow…"
          mono
          onCommit={(v) => write({ 'box-shadow': v || null })}
        />
        <TextField
          value={s.filter ?? ''}
          placeholder="filter: blur(4px)…"
          mono
          onCommit={(v) => write({ filter: v || null })}
        />
      </Section>

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

      {!multi ? <ExportSection pathId={pathIds[0]} /> : null}
    </>
  )
}

function ComponentSection({ instanceId, componentId, variantId }: {
  instanceId: NodeId
  componentId: string
  variantId?: string
}) {
  const def = editorStore.doc.components[componentId]
  const variants = variantsOf(editorStore, componentId)
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
