import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { exportHtml, exportJsx } from '../compiler/export'
import { isAllowedCssProp, isSafeCssValue, sanitizeClasses, sanitizeUrl } from '../compiler/allowlist'
import { px } from '../canvas/geometry'
import { parsePathId } from '../model/instances'
import {
  createMainComponent, detachInstance, setInstanceOverride, setInstanceVariant, variantsOf,
} from '../components/componentCommands'
import { renameNode } from '../commands'
import { editorStore } from '../store/editorStore'
import { useDocVersion, useUi } from '../store/hooks'
import { ColorField, NumberField, Row, Section, SelectField, TextField } from './fields'
import type { NodeId, NodeModel, Op } from '../model/types'

/**
 * Right-hand inspector. Sections adapt to the selection type and write
 * straight to the model (one transaction per commit). Selecting inside a
 * component instance writes overrides instead of touching the definition.
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
  if (!instanceId || instanceId === pathId) return base
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

export function Inspector() {
  useDocVersion()
  const ui = useUi()
  const pathIds = ui.selection
  const first = pathIds[0] ? effectiveNode(pathIds[0]) : null

  return (
    <div
      data-cz-ui
      data-testid="inspector"
      className="cz-panel flex h-full w-60 shrink-0 flex-col overflow-y-auto border-l border-[var(--cz-panel-border)]"
    >
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
          <kbd>O</kbd> ellipse, <kbd>T</kbd> text. Space-drag pans, ⌘-scroll zooms.
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
  const isText = node.text !== undefined || ['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'li'].includes(node.tag)
  const isContainer = !isInstance && ['div', 'section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'ul', 'ol'].includes(node.tag)

  const write = (set: Record<string, string | null>, label?: string) => writeStyle(pathIds, set, label)
  const writeNum = (prop: string, unit = 'px') => (v: number) => write({ [prop]: `${v}${unit}` })

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

      <Section title="Position & size">
        <Row>
          <NumberField label="X" value={px(s.left)} onCommit={writeNum('left')} disabled={px(s.left) === null} />
          <NumberField label="Y" value={px(s.top)} onCommit={writeNum('top')} disabled={px(s.top) === null} />
        </Row>
        <Row>
          <NumberField label="W" value={px(s.width)} min={1} onCommit={writeNum('width')} />
          <NumberField label="H" value={px(s.height)} min={1} onCommit={writeNum('height')} />
        </Row>
        <Row>
          <NumberField
            label="∠"
            value={s.rotate ? parseFloat(s.rotate) || 0 : 0}
            unit="deg"
            onCommit={(v) => write({ rotate: v === 0 ? null : `${v}deg` })}
          />
          <NumberField
            label="◜"
            value={px(s['border-radius']) ?? (s['border-radius'] ? null : 0)}
            min={0}
            onCommit={writeNum('border-radius')}
          />
        </Row>
        <SelectField
          label="Pos"
          value={s.position ?? 'static'}
          options={[
            { value: 'absolute', label: 'Absolute' },
            { value: 'static', label: 'In layout' },
            { value: 'relative', label: 'Relative' },
          ]}
          onCommit={(v) => write(v === 'static' ? { position: null, left: null, top: null } : { position: v })}
        />
      </Section>

      {isContainer ? (
        <Section title="Layout">
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
              <SelectField
                label="Dir"
                value={s['flex-direction'] ?? 'row'}
                options={[
                  { value: 'row', label: 'Horizontal' },
                  { value: 'column', label: 'Vertical' },
                  { value: 'row-reverse', label: 'Horizontal ↩' },
                  { value: 'column-reverse', label: 'Vertical ↩' },
                ]}
                onCommit={(v) => write({ 'flex-direction': v === 'row' ? null : v })}
              />
              <SelectField
                label="Justif"
                value={s['justify-content'] ?? 'flex-start'}
                options={[
                  { value: 'flex-start', label: 'Start' },
                  { value: 'center', label: 'Center' },
                  { value: 'flex-end', label: 'End' },
                  { value: 'space-between', label: 'Space between' },
                  { value: 'space-around', label: 'Space around' },
                ]}
                onCommit={(v) => write({ 'justify-content': v === 'flex-start' ? null : v })}
              />
              <SelectField
                label="Align"
                value={s['align-items'] ?? 'stretch'}
                options={[
                  { value: 'stretch', label: 'Stretch' },
                  { value: 'flex-start', label: 'Start' },
                  { value: 'center', label: 'Center' },
                  { value: 'flex-end', label: 'End' },
                  { value: 'baseline', label: 'Baseline' },
                ]}
                onCommit={(v) => write({ 'align-items': v === 'stretch' ? null : v })}
              />
              <Row>
                <NumberField label="Gap" value={px(s.gap) ?? 0} min={0} onCommit={writeNum('gap')} />
                <SelectField
                  value={s['flex-wrap'] ?? 'nowrap'}
                  options={[
                    { value: 'nowrap', label: 'No wrap' },
                    { value: 'wrap', label: 'Wrap' },
                  ]}
                  onCommit={(v) => write({ 'flex-wrap': v === 'nowrap' ? null : v })}
                />
              </Row>
            </>
          ) : null}
          <Row>
            <NumberField label="Pad" value={px(s.padding) ?? 0} min={0} onCommit={writeNum('padding')} />
            <SelectField
              value={s.overflow ?? 'visible'}
              options={[
                { value: 'visible', label: 'Show overflow' },
                { value: 'hidden', label: 'Clip content' },
                { value: 'auto', label: 'Scroll' },
              ]}
              onCommit={(v) => write({ overflow: v === 'visible' ? null : v })}
            />
          </Row>
        </Section>
      ) : null}

      {/* Child-of-flex sizing */}
      <FlexChildSection pathId={pathIds[0]} write={write} />

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

      <Section title="Stroke">
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
          <SelectField
            label="Align"
            value={s['text-align'] ?? 'left'}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
              { value: 'justify', label: 'Justify' },
            ]}
            onCommit={(v) => write({ 'text-align': v === 'left' ? null : v })}
          />
          <ColorField label="Color" value={s.color ?? ''} allowEmpty onCommit={(v) => write({ color: v })} />
          <TextField
            value={s['font-family'] ?? ''}
            placeholder="font family"
            onCommit={(v) => write({ 'font-family': v || null })}
          />
        </Section>
      ) : null}

      <Section title="Effects">
        <NumberField
          label="Op"
          value={s.opacity ? Math.round(parseFloat(s.opacity) * 100) : 100}
          min={0}
          unit="%"
          onCommit={(v) => write({ opacity: v >= 100 ? null : String(Math.max(0, Math.min(100, v)) / 100) })}
        />
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
        <SelectField
          label="Blend"
          value={s['mix-blend-mode'] ?? 'normal'}
          options={['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'].map((v) => ({
            value: v, label: v,
          }))}
          onCommit={(v) => write({ 'mix-blend-mode': v === 'normal' ? null : v })}
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

function FlexChildSection({ pathId, write }: {
  pathId: string
  write: (set: Record<string, string | null>, label?: string) => void
}) {
  const { sourceId } = parsePathId(pathId)
  const node = editorStore.doc.nodes[sourceId]
  const parent = node?.parent ? editorStore.doc.nodes[node.parent] : null
  if (!parent || parent.style.display !== 'flex') return null
  const grow = node.style['flex-grow'] ?? node.style.flex
  return (
    <Section title="In auto layout">
      <SelectField
        label="Width"
        value={grow ? 'fill' : 'fixed'}
        options={[
          { value: 'fixed', label: 'Fixed / hug' },
          { value: 'fill', label: 'Fill container' },
        ]}
        onCommit={(v) =>
          write(v === 'fill' ? { 'flex-grow': '1', 'flex-basis': '0', width: null } : { 'flex-grow': null, 'flex-basis': null })
        }
      />
      <SelectField
        label="Self"
        value={node.style['align-self'] ?? 'auto'}
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'flex-start', label: 'Start' },
          { value: 'center', label: 'Center' },
          { value: 'flex-end', label: 'End' },
          { value: 'stretch', label: 'Stretch' },
        ]}
        onCommit={(v) => write({ 'align-self': v === 'auto' ? null : v })}
      />
    </Section>
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
