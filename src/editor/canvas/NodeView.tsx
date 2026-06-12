import { createElement, memo, useEffect, useRef, useSyncExternalStore } from 'react'
import { styleToReact } from '../compiler/export'
import { applyOverride, effectiveComponentRoot, overrideFor, stripPlacement } from '../model/instances'
import { SFSymbol } from '@/components/SFSymbol'
import type { SFVariant } from '@/components/SFSymbol'
import { setTextContent } from '../commands'
import { editorStore } from '../store/editorStore'
import { useNode } from '../store/hooks'
import type { CSSProperties, ReactNode, Ref } from 'react'
import type { NodeId, NodeModel } from '../model/types'

/**
 * Model -> live DOM. Each node is one real HTML element; the browser lays it
 * out. Per-node subscriptions mean a style tweak re-renders exactly one
 * component. Component instances expand their definition subtree inline,
 * with per-def-node subscriptions so editing a main component updates every
 * instance immediately.
 */

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input'])

/** HTML attribute -> React prop for the few names React renames. */
const REACT_ATTR: Record<string, string> = {
  for: 'htmlFor', maxlength: 'maxLength', readonly: 'readOnly',
  colspan: 'colSpan', rowspan: 'rowSpan', tabindex: 'tabIndex',
  autocomplete: 'autoComplete', srcset: 'srcSet',
  // SVG presentation attributes React knows only in camelCase.
  'fill-opacity': 'fillOpacity', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset', 'stroke-opacity': 'strokeOpacity',
  'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity',
  'vector-effect': 'vectorEffect', 'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline', 'letter-spacing': 'letterSpacing',
  'font-size': 'fontSize', 'font-family': 'fontFamily', 'font-weight': 'fontWeight',
  'transform-origin': 'transformOrigin',
}

interface RenderParts {
  tag: string
  pathId: string
  attrs: Record<string, string>
  style: Record<string, string>
  classes: string[]
  text?: string
  visible: boolean
  isArtboard?: boolean
  isComponentSet?: boolean
}

function buildProps(parts: RenderParts): Record<string, unknown> {
  const style = styleToReact(parts.style) as CSSProperties & Record<string, string>
  if (!parts.visible) style.display = 'none'
  if (parts.isArtboard || parts.isComponentSet) {
    // Isolate artboard / component-set layout/paint from the rest of the world.
    // `layout style` (not `size`) keeps the set's fit-content sizing intact.
    style.contain = 'layout style'
  }
  const props: Record<string, unknown> = {
    'data-node-id': parts.pathId,
    style,
  }
  if (parts.classes.length > 0) props.className = parts.classes.join(' ')
  for (const [key, value] of Object.entries(parts.attrs)) {
    props[REACT_ATTR[key] ?? key] = value
  }
  if (parts.tag === 'img') props.draggable = false
  // Interactive elements stay inert on the design surface.
  if (parts.tag === 'a') props.onClick = preventDefault
  if (parts.tag === 'input' || parts.tag === 'textarea' || parts.tag === 'select') {
    props.readOnly = true
    props.tabIndex = -1
    if ('value' in parts.attrs) {
      props.value = parts.attrs.value
      props.onChange = noop
    }
  }
  return props
}

const preventDefault = (e: { preventDefault(): void }) => e.preventDefault()
const noop = () => {}

export const NodeView = memo(function NodeView({ id }: { id: NodeId }) {
  const node = useNode(id)
  const isEditing = useSyncExternalStore(
    editorStore.subscribeUi,
    () => editorStore.ui.editingTextId === id,
    () => false,
  )
  if (!node) return null
  if (node.componentId) return <InstanceView instance={node} />

  if (isEditing) return <EditableText node={node} />

  const props = buildProps({
    tag: node.tag, pathId: node.id, attrs: node.attrs, style: node.style,
    classes: node.classes, text: node.text, visible: node.visible,
    isArtboard: node.isArtboard, isComponentSet: node.isComponentSet,
  })
  if (VOID_TAGS.has(node.tag)) return createElement(node.tag, { key: id, ...props })
  let children: ReactNode =
    node.children.length > 0
      ? node.children.map((c) => <NodeView key={c} id={c} />)
      : node.text ?? null
  // Figma-style set label: render-only chrome (no model node, no data-node-id),
  // so it sits above the variants without touching geometry, layout, or export.
  if (node.isComponentSet) {
    children = [<SetLabel key="__cz_set_label" name={node.name} />, children]
  }
  return createElement(node.tag, { key: id, ...props }, children)
})

/** The component-set name, floated in the frame's header padding zone. */
function SetLabel({ name }: { name: string }) {
  return (
    <span
      data-canvas-chrome=""
      style={{
        position: 'absolute', top: '16px', left: '24px',
        fontSize: '12px', fontWeight: 600, color: '#8b5cf6',
        pointerEvents: 'none', userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      {name}
    </span>
  )
}

/** In-place text editing: the actual element becomes contentEditable. */
function EditableText({ node }: { node: NodeModel }) {
  const ref = useRef<HTMLElement | null>(null)
  const committed = useRef(false)
  // Flattened rich text (children spans) edits as one plain string.
  const initialText =
    node.text ?? node.children.map((c) => editorStore.doc.nodes[c]?.text ?? '').join('')

  useEffect(() => {
    // StrictMode runs mount -> cleanup -> mount; reset so the second mount
    // keeps editing and the throwaway cleanup is a no-op.
    committed.current = false
    const el = ref.current
    if (!el) return
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    return () => commit(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Commit text; optionally end editing (cleanup must not end it). */
  const commit = (clearEditing: boolean) => {
    const el = ref.current
    if (!committed.current && el && el.textContent !== initialText) {
      committed.current = true
      setTextContent({ store: editorStore }, node.id, el.textContent ?? '')
    }
    if (clearEditing && editorStore.ui.editingTextId === node.id) {
      editorStore.setUi({ editingTextId: null })
    }
  }

  const props = buildProps({
    tag: node.tag, pathId: node.id, attrs: node.attrs, style: node.style,
    classes: node.classes, text: node.text, visible: node.visible,
  })
  return createElement(node.tag, {
    ...props,
    ref: ref as Ref<HTMLElement>,
    contentEditable: true,
    suppressContentEditableWarning: true,
    'data-canvas-text': true,
    onBlur: () => commit(true),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        commit(true)
      }
    },
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  }, initialText)
}

/** Renders an instance by expanding its component definition. */
function InstanceView({ instance }: { instance: NodeModel }) {
  const rootId = effectiveComponentRoot(editorStore.doc, instance)
  if (!rootId) return null
  return <DefNodeView defId={rootId} instance={instance} isRoot seen={EMPTY_SET} />
}

const EMPTY_SET: ReadonlySet<string> = new Set()

const DefNodeView = memo(function DefNodeView({
  defId,
  instance,
  isRoot,
  seen,
}: {
  defId: NodeId
  instance: NodeModel
  isRoot?: boolean
  seen: ReadonlySet<string>
}) {
  const defNode = useNode(defId)
  if (!defNode) return null
  const override = overrideFor(instance, defNode)

  // Nested instance (or swapped one) inside the definition.
  if (defNode.componentId && !isRoot) {
    const effective: NodeModel = override?.componentId || override?.variantId
      ? { ...defNode, componentId: override.componentId ?? defNode.componentId, variantId: override.variantId ?? defNode.variantId }
      : defNode
    const nestedDefId = effective.variantId ?? effective.componentId
    if (!nestedDefId || seen.has(nestedDefId)) return null
    const rootId = effectiveComponentRoot(editorStore.doc, effective)
    if (!rootId) return null
    const nested: NodeModel = { ...effective, id: `${instance.id}:${defId}` }
    return (
      <DefNodeView
        defId={rootId}
        instance={nested}
        isRoot
        seen={new Set(seen).add(nestedDefId)}
      />
    )
  }

  const merged = applyOverride(defNode, override)
  let style = merged.style
  let classes = merged.classes
  let visible = merged.visible
  let text = merged.text
  if (isRoot) {
    style = { ...stripPlacement(style), ...instance.style }
    classes = instance.classes.length > 0 ? instance.classes : classes
    visible = instance.visible
    if (instance.text !== undefined) text = instance.text
  }

  const pathId = isRoot ? instance.id : `${instance.id}:${defId}`

  // Icon prop: an overridden data-cz-icon renders the live SF Symbol — the
  // definition's static paths belong to the old glyph.
  const effIcon = merged.attrs['data-cz-icon']
  if (defNode.tag === 'svg' && effIcon && effIcon !== defNode.attrs['data-cz-icon']) {
    const reactStyle = styleToReact(style) as CSSProperties & Record<string, string>
    if (!visible) reactStyle.display = 'none'
    return (
      <SFSymbol
        name={effIcon}
        variant={(merged.attrs['data-cz-variant'] as SFVariant) ?? 'monochrome'}
        size={parseFloat(merged.attrs.width ?? '') || 24}
        data-node-id={pathId}
        data-cz-icon={effIcon}
        style={reactStyle}
      />
    )
  }

  const props = buildProps({
    tag: defNode.tag, pathId, attrs: merged.attrs, style, classes, text, visible,
  })
  if (VOID_TAGS.has(defNode.tag)) return createElement(defNode.tag, props)
  const children: ReactNode =
    defNode.children.length > 0
      ? defNode.children.map((c) => (
          <DefNodeView key={c} defId={c} instance={instance} seen={seen} />
        ))
      : text ?? null
  return createElement(defNode.tag, props, children)
})
