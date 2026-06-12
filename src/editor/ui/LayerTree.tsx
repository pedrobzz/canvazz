import {
  ChevronDown, ChevronRight, Columns3, Component, Diamond, Eye, EyeOff, Frame, Group,
  Image, List, Lock, LockOpen, MousePointerClick, Rows3, Shapes, Square, Type,
} from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { controllerRef } from '../canvas/CanvasRoot'
import { clipboard, setClipboard } from '../clipboard'
import { exportHtml, exportJsx } from '../compiler/export'
import {
  canReceiveChildren, copyNodes, deleteNodes, duplicateNodes, groupNodes,
  isLayoutContainer, pasteHtml, renameNode, reorderNodes, setLocked,
  setVisibility, ungroupNodes,
} from '../commands'
import { parsePathId } from '../model/instances'
import { editorStore } from '../store/editorStore'
import { useDocVersion, useUi } from '../store/hooks'
import type { ZOrder } from '../commands'
import type { NodeId, NodeModel } from '../model/types'

/**
 * Layer tree with ARIA tree semantics, keyboard navigation, inline rename,
 * drag-to-reorder/reparent, lock/visibility toggles, and a full right-click
 * menu (copy/paste, arrange, group, …). Rows render top-of-z-stack first
 * (reversed DOM order), like every design tool.
 */

interface FlatRow {
  id: NodeId
  depth: number
  node: NodeModel
  hasChildren: boolean
  expanded: boolean
}

type DropPos = 'before' | 'after' | 'inside'

export function LayerTree() {
  useDocVersion()
  const ui = useUi()
  const [expandedSet, setExpanded] = useState<ReadonlySet<NodeId>>(new Set())
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [dropMark, setDropMark] = useState<{ id: NodeId; pos: DropPos } | null>(null)
  // One context menu serves every row (a radix root per row is too heavy for
  // large trees); right-clicking a row records it as the menu target.
  const [menuTarget, setMenuTarget] = useState<NodeId | null>(null)
  const treeRef = useRef<HTMLUListElement>(null)
  const lastClicked = useRef<NodeId | null>(null)

  const doc = editorStore.doc
  const page = editorStore.activePage()

  // Auto-expand ancestors of the selection so selected layers are visible.
  useEffect(() => {
    if (ui.selection.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let grew = false
      for (const pathId of ui.selection) {
        let cur = doc.nodes[pathId.split(':')[0]]?.parent ?? null
        while (cur) {
          if (!next.has(cur)) {
            next.add(cur)
            grew = true
          }
          cur = doc.nodes[cur]?.parent ?? null
        }
      }
      return grew ? next : prev
    })
  }, [ui.selection, doc])

  const rows: FlatRow[] = []
  // Free/absolute containers list top-of-z first (reversed children); auto-
  // layout containers list in flow order, so the tree matches the canvas.
  const pushRows = (ids: NodeId[], depth: number, flowOrdered: boolean) => {
    const ordered = flowOrdered ? ids : [...ids].reverse()
    for (const id of ordered) {
      const node = doc.nodes[id]
      if (!node) continue
      const hasChildren = node.children.length > 0 && !node.componentId
      const expanded = expandedSet.has(node.id)
      rows.push({ id: node.id, depth, node, hasChildren, expanded })
      if (hasChildren && expanded) pushRows(node.children, depth + 1, isLayoutContainer(node))
    }
  }
  pushRows(page.children, 0, false)

  // Scroll selected row into view.
  useEffect(() => {
    if (ui.selection.length === 0) return
    const row = treeRef.current?.querySelector(`[data-layer-id="${CSS.escape(ui.selection[0])}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [ui.selection])

  const select = (id: NodeId, e: React.MouseEvent) => {
    if (e.shiftKey && lastClicked.current) {
      const ids = rows.map((r) => r.id)
      const a = ids.indexOf(lastClicked.current)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        editorStore.setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1))
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      const sel = editorStore.ui.selection
      editorStore.setSelection(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id])
    } else {
      editorStore.setSelection([id])
    }
    lastClicked.current = id
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ids = rows.map((r) => r.id)
    const current = ids.indexOf(ui.selection[0] ?? '')
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = ids[Math.min(ids.length - 1, current + 1)]
        if (next) editorStore.setSelection([next])
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const next = ids[Math.max(0, current - 1)]
        if (next) editorStore.setSelection([next])
        break
      }
      case 'ArrowRight': {
        const row = rows[current]
        if (row?.hasChildren) setExpanded(new Set(expandedSet).add(row.id))
        break
      }
      case 'ArrowLeft': {
        const row = rows[current]
        if (row?.expanded) {
          const next = new Set(expandedSet)
          next.delete(row.id)
          setExpanded(next)
        } else if (row?.node.parent) {
          editorStore.setSelection([row.node.parent])
        }
        break
      }
      case 'Enter':
        if (ui.selection[0]) setRenaming(ui.selection[0])
        e.preventDefault()
        break
    }
  }

  const onDrop = (targetId: NodeId, pos: DropPos) => {
    setDropMark(null)
    const dragged = editorStore.ui.selection.filter((id) => !id.includes(':'))
    if (dragged.length === 0 || dragged.includes(targetId)) return
    const target = doc.nodes[targetId]
    if (!target) return
    for (const id of dragged) {
      if (isAncestorOf(id, targetId)) return
    }
    if (pos === 'inside') {
      const intoFlow = isLayoutContainer(target)
      editorStore.apply('Reparent', dragged.flatMap((id) => {
        const ops: import('../model/types').Op[] = [
          { t: 'move' as const, id, to: { kind: 'node' as const, parent: targetId, index: 0 } },
        ]
        // Joining an auto-layout container means joining the flow.
        if (intoFlow && doc.nodes[id]?.style.position === 'absolute') {
          ops.push({ t: 'setStyle' as const, id, set: { position: null, left: null, top: null } })
        }
        return ops
      }))
      return
    }
    // Tree position -> child index depends on the parent's ordering mode:
    // flow-ordered (auto layout) lists match the array; z-ordered lists are
    // reversed, so before/after swap.
    const parentNode = target.parent ? doc.nodes[target.parent] : null
    const flowOrdered = parentNode ? isLayoutContainer(parentNode) : false
    const loc = target.parent
      ? { kind: 'node' as const, parent: target.parent }
      : { kind: 'page' as const, pageId: page.id }
    const siblings = target.parent ? doc.nodes[target.parent].children : page.children
    const base = siblings.indexOf(targetId)
    const index = pos === 'before' ? (flowOrdered ? base : base + 1) : (flowOrdered ? base + 1 : base)
    editorStore.apply('Reorder', dragged.map((id) => ({
      t: 'move' as const, id, to: { ...loc, index },
    })))
  }

  const menuNode = menuTarget ? doc.nodes[menuTarget] : null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ul
          ref={treeRef}
          role="tree"
          aria-label="Layers"
          aria-multiselectable
          tabIndex={0}
          data-testid="layer-tree"
          className="flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--cz-accent)]"
          onKeyDown={onKeyDown}
        >
          {rows.map((row) => (
            <LayerRow
              key={row.id}
              row={row}
              selected={ui.selection.includes(row.id)}
              hovered={ui.hoverId === row.id}
              renaming={renaming === row.id}
              dropMark={dropMark?.id === row.id ? dropMark.pos : null}
              onSelect={select}
              onToggleExpand={(id) => {
                const next = new Set(expandedSet)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                setExpanded(next)
              }}
              onRenameStart={setRenaming}
              onRenameEnd={() => setRenaming(null)}
              onDragMark={(id, pos) => setDropMark(pos ? { id, pos } : null)}
              onDrop={onDrop}
              onMenuTarget={setMenuTarget}
            />
          ))}
          {rows.length === 0 ? (
            <li className="px-3 py-2 text-[11px] text-[var(--cz-panel-muted)]">
              No layers yet — draw a frame (F) or shape (R) to get started.
            </li>
          ) : null}
        </ul>
      </ContextMenuTrigger>
      {menuNode ? (
        <LayerMenu
          node={menuNode}
          onRename={() => setRenaming(menuNode.id)}
          onRevealChildren={() => setExpanded(new Set(expandedSet).add(menuNode.id))}
        />
      ) : (
        <ContextMenuContent>
          <ContextMenuItem disabled={!clipboard.html} onSelect={() => pasteHtml(cmdCtx(), clipboard.html)}>
            Paste <ContextMenuShortcut>⌘V</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

function isAncestorOf(maybeAncestor: NodeId, id: NodeId): boolean {
  let cur = editorStore.doc.nodes[id]?.parent ?? null
  while (cur) {
    if (cur === maybeAncestor) return true
    cur = editorStore.doc.nodes[cur]?.parent ?? null
  }
  return false
}

// --- Context menu actions ----------------------------------------------------

const cmdCtx = () => ({
  store: editorStore,
  getRect: (pathId: string) => controllerRef.current?.rectOf(pathId) ?? null,
})

/** Selected source ids (instance internals act on their instance root). */
const selIds = () => editorStore.ui.selection.map((s) => parsePathId(s).sourceId)

function LayerMenu({ node, onRename, onRevealChildren }: {
  node: NodeModel
  onRename: () => void
  onRevealChildren: () => void
}) {
  const multi = editorStore.ui.selection.length > 1
  const copy = () => setClipboard(copyNodes(cmdCtx(), selIds()))
  const copyAs = (kind: 'html' | 'jsx') => {
    const exporter = kind === 'html' ? exportHtml : exportJsx
    const code = selIds().map((id) => exporter(editorStore.doc, id)).join('\n\n')
    void navigator.clipboard?.writeText(code).catch(() => {})
  }
  const arrange = (dir: ZOrder) => reorderNodes(cmdCtx(), selIds(), dir)

  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={copy}>
        Copy <ContextMenuShortcut>⌘C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Copy as</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onSelect={() => copyAs('html')}>Copy as HTML</ContextMenuItem>
          <ContextMenuItem onSelect={() => copyAs('jsx')}>Copy as JSX</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem disabled={!clipboard.html} onSelect={() => pasteHtml(cmdCtx(), clipboard.html)}>
        Paste <ContextMenuShortcut>⌘V</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          const ids = duplicateNodes(cmdCtx(), selIds())
          if (ids.length > 0) {
            editorStore.setSelection(ids)
            editorStore.recordSelectionAfter()
          }
        }}
      >
        Duplicate <ContextMenuShortcut>⌘D</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem disabled={!multi} onSelect={() => groupNodes(cmdCtx(), selIds())}>
        Group selection <ContextMenuShortcut>⌘G</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={node.children.length === 0 || node.isArtboard || Boolean(node.componentId)}
        onSelect={() => ungroupNodes(cmdCtx(), selIds())}
      >
        Ungroup <ContextMenuShortcut>⇧⌘G</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem
        onSelect={() => selIds().forEach((id) => setVisibility(cmdCtx(), id, !node.visible))}
      >
        {node.visible ? 'Hide' : 'Show'}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => selIds().forEach((id) => setLocked(cmdCtx(), id, !node.locked))}
      >
        {node.locked ? 'Unlock' : 'Lock'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onRename}>
        Rename <ContextMenuShortcut>↵</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuSub>
        <ContextMenuSubTrigger>Arrange</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onSelect={() => arrange('front')}>
            Bring to front <ContextMenuShortcut>⌥⌘]</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => arrange('forward')}>
            Move forward <ContextMenuShortcut>⌘]</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => arrange('backward')}>
            Move backward <ContextMenuShortcut>⌘[</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => arrange('back')}>
            Send to back <ContextMenuShortcut>⌥⌘[</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />

      <ContextMenuItem
        disabled={!node.parent}
        onSelect={() => node.parent && editorStore.setSelection([node.parent])}
      >
        Select parent <ContextMenuShortcut>Esc</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={node.children.length === 0 || Boolean(node.componentId)}
        onSelect={() => {
          onRevealChildren()
          editorStore.setSelection([...node.children])
        }}
      >
        Select children
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => controllerRef.current?.zoomToSelection()}>
        Zoom to selection <ContextMenuShortcut>⌘2</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem variant="destructive" onSelect={() => deleteNodes(cmdCtx(), selIds())}>
        Delete <ContextMenuShortcut>⌫</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

// --- Rows ---------------------------------------------------------------------

const TEXT_TAGS = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'label', 'blockquote', 'code', 'pre', 'strong', 'em'])

/** Figma-style per-layer type icon. */
function LayerIcon({ node }: { node: NodeModel }) {
  const cls = 'size-3 shrink-0'
  // Set frame = the 4-diamond cluster; a variant root (a component root nested
  // in a set) = a single diamond; a lone component / instance = the cluster.
  if (node.isComponentSet) {
    return <Component className={`${cls} text-[var(--cz-ai)]`} />
  }
  if (node.isComponentRoot) {
    const parent = node.parent ? editorStore.doc.nodes[node.parent] : null
    return parent?.isComponentSet ? (
      <Diamond className={`${cls} text-[var(--cz-ai)]`} />
    ) : (
      <Component className={`${cls} text-[var(--cz-ai)]`} />
    )
  }
  if (node.componentId) {
    return <Component className={`${cls} text-[var(--cz-ai)]`} />
  }
  const muted = `${cls} text-[var(--cz-panel-muted)]`
  if (node.isArtboard) return <Frame className={muted} />
  if (node.tag === 'svg') return <Shapes className={muted} />
  if (node.tag === 'img') return <Image className={muted} />
  if (node.tag === 'button') return <MousePointerClick className={muted} />
  if (node.tag === 'ul' || node.tag === 'ol' || node.tag === 'li') return <List className={muted} />
  if (TEXT_TAGS.has(node.tag) || node.text !== undefined) return <Type className={muted} />
  if (isLayoutContainer(node)) {
    const column = (node.style['flex-direction'] ?? '').startsWith('column') || node.classes.includes('flex-col')
    return column ? <Rows3 className={muted} /> : <Columns3 className={muted} />
  }
  if (node.children.length > 0) return <Group className={muted} />
  return <Square className={muted} />
}

const LayerRow = memo(function LayerRow({
  row, selected, hovered, renaming, dropMark,
  onSelect, onToggleExpand, onRenameStart, onRenameEnd, onDragMark, onDrop, onMenuTarget,
}: {
  row: FlatRow
  selected: boolean
  hovered: boolean
  renaming: boolean
  dropMark: DropPos | null
  onSelect: (id: NodeId, e: React.MouseEvent) => void
  onToggleExpand: (id: NodeId) => void
  onRenameStart: (id: NodeId) => void
  onRenameEnd: () => void
  onDragMark: (id: NodeId, pos: DropPos | null) => void
  onDrop: (id: NodeId, pos: DropPos) => void
  onMenuTarget: (id: NodeId) => void
}) {
  const { node } = row
  const isComponentish = Boolean(node.componentId || node.isComponentRoot || node.isComponentSet)
  return (
    <li
          role="treeitem"
          aria-selected={selected}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-level={row.depth + 1}
          data-layer-id={row.id}
          draggable={!renaming}
          className={[
            'group relative mx-1 flex h-7 cursor-default select-none items-center gap-1 rounded-md pr-1.5 text-[11.5px]',
            selected
              ? 'bg-[var(--cz-accent)]/25 text-white'
              : hovered
                ? 'bg-[var(--cz-panel-hover)]'
                : 'hover:bg-[var(--cz-panel-hover)]',
            node.visible ? '' : 'opacity-45',
            dropMark === 'inside' ? 'ring-1 ring-inset ring-[var(--cz-accent)]' : '',
          ].join(' ')}
          style={{ paddingLeft: 6 + row.depth * 14 }}
          onClick={(e) => onSelect(row.id, e)}
          onDoubleClick={() => onRenameStart(row.id)}
          onContextMenu={() => {
            // The bubbling event opens the tree-level context menu for this row.
            if (!editorStore.ui.selection.includes(row.id)) editorStore.setSelection([row.id])
            onMenuTarget(row.id)
          }}
          onPointerEnter={() => editorStore.setUi({ hoverId: row.id })}
          onPointerLeave={() => {
            if (editorStore.ui.hoverId === row.id) editorStore.setUi({ hoverId: null })
          }}
          onDragStart={(e) => {
            if (!editorStore.ui.selection.includes(row.id)) editorStore.setSelection([row.id])
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            const y = (e.clientY - rect.top) / rect.height
            const canNest = canReceiveChildren(node)
            const pos: DropPos = y < 0.3 ? 'before' : y > 0.7 ? 'after' : canNest ? 'inside' : 'after'
            onDragMark(row.id, pos)
          }}
          onDragLeave={() => onDragMark(row.id, null)}
          onDrop={(e) => {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            const y = (e.clientY - rect.top) / rect.height
            const canNest = canReceiveChildren(node)
            const pos: DropPos = y < 0.3 ? 'before' : y > 0.7 ? 'after' : canNest ? 'inside' : 'after'
            onDrop(row.id, pos)
          }}
        >
          {row.depth > 0
            ? Array.from({ length: row.depth }, (_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="pointer-events-none absolute top-0 h-full w-px bg-white/[0.06]"
                  style={{ left: 12 + i * 14 }}
                />
              ))
            : null}
          {dropMark === 'before' ? (
            <div className="absolute inset-x-0 top-0 h-0.5 rounded bg-[var(--cz-accent)]" />
          ) : null}
          {dropMark === 'after' ? (
            <div className="absolute inset-x-0 bottom-0 h-0.5 rounded bg-[var(--cz-accent)]" />
          ) : null}

          {row.hasChildren ? (
            <button
              aria-label={row.expanded ? 'Collapse' : 'Expand'}
              className="flex size-4 shrink-0 items-center justify-center text-[var(--cz-panel-muted)] hover:text-white"
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand(row.id)
              }}
            >
              {row.expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}

          <LayerIcon node={node} />

          {renaming ? (
            <input
              autoFocus
              defaultValue={node.name}
              className="h-5 flex-1"
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== node.name) {
                  renameNode({ store: editorStore }, row.id, e.target.value.trim())
                }
                onRenameEnd()
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') onRenameEnd()
              }}
            />
          ) : (
            <span className={`truncate ${isComponentish && !selected ? 'text-[var(--cz-ai)]' : ''}`}>
              {node.name}
            </span>
          )}

          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <button
              aria-label={node.locked ? 'Unlock' : 'Lock'}
              className={`p-0.5 ${node.locked ? 'text-white opacity-100' : 'text-[var(--cz-panel-muted)] hover:text-white'}`}
              style={node.locked ? { opacity: 1 } : undefined}
              onClick={(e) => {
                e.stopPropagation()
                setLocked({ store: editorStore }, row.id, !node.locked)
              }}
            >
              {node.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
            </button>
            <button
              aria-label={node.visible ? 'Hide' : 'Show'}
              className="p-0.5 text-[var(--cz-panel-muted)] hover:text-white"
              onClick={(e) => {
                e.stopPropagation()
                setVisibility({ store: editorStore }, row.id, !node.visible)
              }}
            >
              {node.visible ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            </button>
          </span>
          {node.locked ? <Lock className="absolute right-2 size-3 text-[var(--cz-panel-muted)] group-hover:hidden" /> : null}
    </li>
  )
})
