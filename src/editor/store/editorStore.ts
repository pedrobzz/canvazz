import { applyOps, emptyDocument } from '../model/doc'
import { genId } from '../model/ids'
import type { DocumentModel, NodeId, Op, Transaction, TransactionSource } from '../model/types'

export type Tool =
  | 'select'
  | 'hand'
  | 'frame'
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'star'
  | 'comment'
  | 'component'
  | 'ai'

export interface UiState {
  tool: Tool
  selection: NodeId[]
  hoverId: NodeId | null
  editingTextId: NodeId | null
  showGrid: boolean
  snapping: boolean
  /** Node ids touched by the most recent AI transaction, for indicators. */
  aiChanged: NodeId[]
}

interface HistoryEntry {
  tx: Transaction
  selectionBefore: NodeId[]
  selectionAfter: NodeId[]
}

export interface LogEntry {
  id: string
  label: string
  source: TransactionSource
  changed: NodeId[]
  at: number
  undone: boolean
}

type Listener = () => void

/**
 * External editor state. Hot interactions (drag/resize/pan) never touch this
 * store mid-gesture — they write to the DOM directly and commit one
 * transaction on pointer-up, so React work stays off the pointer path.
 */
export class EditorStore {
  doc: DocumentModel
  ui: UiState = {
    tool: 'select',
    selection: [],
    hoverId: null,
    editingTextId: null,
    showGrid: false,
    snapping: true,
    aiChanged: [],
  }
  /** Bumped on every doc change; doc-wide subscribers key off this. */
  docVersion = 0
  log: LogEntry[] = []

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private nodeListeners = new Map<NodeId, Set<Listener>>()
  private docListeners = new Set<Listener>()
  private uiListeners = new Set<Listener>()
  /** Notified after any transaction commit, with the transaction. */
  private txListeners = new Set<(tx: Transaction) => void>()

  constructor(doc?: DocumentModel) {
    this.doc = doc ?? emptyDocument(genId('doc'), 'Untitled')
  }

  // --- Subscriptions -------------------------------------------------------

  subscribeNode = (id: NodeId) => (fn: Listener) => {
    let set = this.nodeListeners.get(id)
    if (!set) this.nodeListeners.set(id, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.nodeListeners.delete(id)
    }
  }

  subscribeDoc = (fn: Listener) => {
    this.docListeners.add(fn)
    return () => this.docListeners.delete(fn)
  }

  subscribeUi = (fn: Listener) => {
    this.uiListeners.add(fn)
    return () => this.uiListeners.delete(fn)
  }

  subscribeTx = (fn: (tx: Transaction) => void) => {
    this.txListeners.add(fn)
    return () => this.txListeners.delete(fn)
  }

  getNode = (id: NodeId) => this.doc.nodes[id] ?? null

  // --- Mutations -----------------------------------------------------------

  apply(label: string, ops: Op[], source: TransactionSource = 'user'): Transaction | null {
    if (ops.length === 0) return null
    const selectionBefore = this.ui.selection
    const { doc, inverse, changed } = applyOps(this.doc, ops)
    this.doc = doc
    const tx: Transaction = { id: genId('tx'), label, source, ops, inverse, changed, at: Date.now() }
    this.undoStack.push({ tx, selectionBefore, selectionAfter: this.ui.selection })
    if (this.undoStack.length > 500) this.undoStack.shift()
    this.redoStack = []
    this.log = [...this.log.slice(-199), {
      id: tx.id, label, source, changed, at: tx.at, undone: false,
    }]
    if (source === 'ai') this.setUi({ aiChanged: changed })
    this.commit(changed)
    for (const fn of this.txListeners) fn(tx)
    return tx
  }

  /** Re-records selectionAfter for the latest entry (set selection post-apply). */
  recordSelectionAfter() {
    const last = this.undoStack[this.undoStack.length - 1]
    if (last) last.selectionAfter = this.ui.selection
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    const { doc, changed } = applyOps(this.doc, entry.tx.inverse)
    this.doc = doc
    this.redoStack.push(entry)
    this.log = this.log.map((l) => (l.id === entry.tx.id ? { ...l, undone: true } : l))
    this.setSelection(entry.selectionBefore.filter((id) => this.doc.nodes[id]))
    this.commit(changed)
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    const { doc, changed } = applyOps(this.doc, entry.tx.ops)
    this.doc = doc
    this.undoStack.push(entry)
    this.log = this.log.map((l) => (l.id === entry.tx.id ? { ...l, undone: false } : l))
    this.setSelection(entry.selectionAfter.filter((id) => this.doc.nodes[id]))
    this.commit(changed)
    return true
  }

  canUndo = () => this.undoStack.length > 0
  canRedo = () => this.redoStack.length > 0

  /** Replace the whole document (load from disk, import). Clears history. */
  replaceDocument(doc: DocumentModel) {
    // Normalize documents saved before newer model fields existed.
    this.doc = {
      ...doc,
      tokens: doc.tokens ?? {},
      fonts: doc.fonts ?? {},
      assets: doc.assets ?? {},
      componentSets: doc.componentSets ?? {},
      comments: doc.comments ?? [],
    }
    this.undoStack = []
    this.redoStack = []
    this.setUi({ selection: [], hoverId: null, editingTextId: null, aiChanged: [] })
    this.docVersion++
    for (const fn of this.docListeners) fn()
    for (const set of this.nodeListeners.values()) for (const fn of set) fn()
  }

  private commit(changed: NodeId[]) {
    this.docVersion++
    // Prune selection of nodes that no longer exist.
    if (this.ui.selection.some((id) => !this.doc.nodes[id])) {
      this.ui = { ...this.ui, selection: this.ui.selection.filter((id) => this.doc.nodes[id]) }
      for (const fn of this.uiListeners) fn()
    }
    for (const id of changed) {
      const set = this.nodeListeners.get(id)
      if (set) for (const fn of set) fn()
    }
    for (const fn of this.docListeners) fn()
  }

  // --- UI state ------------------------------------------------------------

  setUi(patch: Partial<UiState>) {
    this.ui = { ...this.ui, ...patch }
    for (const fn of this.uiListeners) fn()
  }

  setSelection(ids: NodeId[]) {
    const valid = ids.filter((id) => this.doc.nodes[id])
    const same =
      valid.length === this.ui.selection.length && valid.every((id, i) => id === this.ui.selection[i])
    if (!same) this.setUi({ selection: valid })
  }

  setTool(tool: Tool) {
    if (this.ui.tool !== tool) this.setUi({ tool })
  }

  /** Switch the visible page. Not undoable — it's view state, like camera. */
  setActivePage(id: string) {
    if (this.doc.activePageId === id || !this.doc.pages.some((p) => p.id === id)) return
    this.doc = { ...this.doc, activePageId: id }
    this.setUi({ selection: [], hoverId: null, editingTextId: null, aiChanged: [] })
    this.docVersion++
    for (const fn of this.docListeners) fn()
  }

  // --- Queries -------------------------------------------------------------

  activePage() {
    const page = this.doc.pages.find((p) => p.id === this.doc.activePageId) ?? this.doc.pages[0]
    if (!page) throw new Error('Document has no pages')
    return page
  }

  /** Page a node ultimately belongs to (walks to the top-level ancestor). */
  pageOf(id: NodeId): string | null {
    let cur: NodeId | null = id
    while (cur) {
      const node: (typeof this.doc.nodes)[string] | undefined = this.doc.nodes[cur]
      if (!node) return null
      if (!node.parent) {
        const page = this.doc.pages.find((p) => p.children.includes(cur as NodeId))
        return page?.id ?? null
      }
      cur = node.parent
    }
    return null
  }
}

/** Singleton store for the app; tests construct their own instances. */
export const editorStore = new EditorStore()
