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
