import { ChevronDown, ChevronRight, Component, Eye, EyeOff, Lock, LockOpen } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { renameNode, setLocked, setVisibility } from '../commands'
import { editorStore } from '../store/editorStore'
import { useDocVersion, useUi } from '../store/hooks'
import type { NodeId, NodeModel } from '../model/types'

/**
 * Layer tree with ARIA tree semantics, keyboard navigation, inline rename,
 * drag-to-reorder/reparent, and lock/visibility toggles. Rows render
 * top-of-z-stack first (reversed DOM order), like every design tool.
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
  const pushRows = (ids: NodeId[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const node = doc.nodes[ids[i]]
      if (!node) continue
      const hasChildren = node.children.length > 0 && !node.componentId
      const expanded = expandedSet.has(node.id)
      rows.push({ id: node.id, depth, node, hasChildren, expanded })
      if (hasChildren && expanded) pushRows(node.children, depth + 1)
    }
  }
  pushRows(page.children, 0)

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
      editorStore.apply('Reparent', dragged.map((id) => ({
        t: 'move' as const, id, to: { kind: 'node' as const, parent: targetId, index: 0 },
      })))
      return
    }
    // before/after in tree = after/before in child order (tree is reversed).
    const loc = target.parent
      ? { kind: 'node' as const, parent: target.parent }
      : { kind: 'page' as const, pageId: page.id }
    const siblings = target.parent ? doc.nodes[target.parent].children : page.children
    const base = siblings.indexOf(targetId)
    const index = pos === 'before' ? base + 1 : base
    editorStore.apply('Reorder', dragged.map((id) => ({
      t: 'move' as const, id, to: { ...loc, index },
    })))
  }

  return (
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
        />
      ))}
      {rows.length === 0 ? (
        <li className="px-3 py-2 text-[11px] text-[var(--cz-panel-muted)]">
          No layers yet — draw a frame (F) or shape (R) to get started.
        </li>
      ) : null}
    </ul>
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

const LayerRow = memo(function LayerRow({
  row, selected, hovered, renaming, dropMark,
  onSelect, onToggleExpand, onRenameStart, onRenameEnd, onDragMark, onDrop,
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
}) {
  const { node } = row
  const isComponent = node.isComponentRoot || Boolean(node.componentId)
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-level={row.depth + 1}
      data-layer-id={row.id}
      draggable={!renaming}
      className={[
        'group relative flex h-7 cursor-default select-none items-center gap-1 pr-2 text-[11.5px]',
        selected
          ? 'bg-[var(--cz-panel-active)] text-white'
          : hovered
            ? 'bg-[var(--cz-panel-hover)]'
            : 'hover:bg-[var(--cz-panel-hover)]',
        node.visible ? '' : 'opacity-45',
        dropMark === 'inside' ? 'ring-1 ring-inset ring-[var(--cz-accent)]' : '',
      ].join(' ')}
      style={{ paddingLeft: 8 + row.depth * 14 }}
      onClick={(e) => onSelect(row.id, e)}
      onDoubleClick={() => onRenameStart(row.id)}
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
        const canNest = node.children.length >= 0 && !node.componentId && node.tag === 'div'
        const pos: DropPos = y < 0.3 ? 'before' : y > 0.7 ? 'after' : canNest ? 'inside' : 'after'
        onDragMark(row.id, pos)
      }}
      onDragLeave={() => onDragMark(row.id, null)}
      onDrop={(e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        const y = (e.clientY - rect.top) / rect.height
        const canNest = node.children.length >= 0 && !node.componentId && node.tag === 'div'
        const pos: DropPos = y < 0.3 ? 'before' : y > 0.7 ? 'after' : canNest ? 'inside' : 'after'
        onDrop(row.id, pos)
      }}
    >
      {dropMark === 'before' ? (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-[var(--cz-accent)]" />
      ) : null}
      {dropMark === 'after' ? (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--cz-accent)]" />
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

      {isComponent ? <Component className="size-3 shrink-0 text-[var(--cz-ai)]" /> : null}

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
        <span className="truncate">{node.name}</span>
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
