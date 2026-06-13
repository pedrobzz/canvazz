import { applyOps, emptyDocument } from '../model/doc'
import { migrateDocument } from '../model/migrate'
import { genId } from '../model/ids'
import type {
  CommentAuthor, CommentMessage, CommentRect, CommentThread,
  DocumentModel, NodeId, Op, Transaction, TransactionSource,
} from '../model/types'

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

/** A comment being placed but not yet submitted — the open composer's anchor. */
export interface CommentDraft {
  x: number
  y: number
  nodeIds: NodeId[]
  area?: CommentRect
}

export interface UiState {
  tool: Tool
  selection: NodeId[]
  hoverId: NodeId | null
  editingTextId: NodeId | null
  showGrid: boolean
  snapping: boolean
  /** Node ids touched by the most recent AI transaction, for indicators. */
  aiChanged: NodeId[]
  /** Thread whose card is open on the canvas, if any. */
  activeCommentId: string | null
  /** A comment being composed (composer open at this anchor), if any. */
  commentDraft: CommentDraft | null
}

interface HistoryEntry {
  tx: Transaction
  selectionBefore: NodeId[]
  selectionAfter: NodeId[]
  /** Commits sharing this key fold into one entry (drag-scrub gestures). */
  mergeKey?: string
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
    activeCommentId: null,
    commentDraft: null,
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

  apply(
    label: string,
    ops: Op[],
    source: TransactionSource = 'user',
    opts?: { mergeKey?: string },
  ): Transaction | null {
    if (ops.length === 0) return null
    const selectionBefore = this.ui.selection
    const { doc, inverse, changed } = applyOps(this.doc, ops)
    this.doc = doc
    const prev = this.undoStack[this.undoStack.length - 1]
    if (opts?.mergeKey && prev?.mergeKey === opts.mergeKey) {
      // Same gesture: fold into the previous entry so one scrub = one undo.
      // Inverses prepend — undo applies the newest inverse first.
      const tx = prev.tx
      tx.ops = [...tx.ops, ...ops]
      tx.inverse = [...inverse, ...tx.inverse]
      tx.changed = [...new Set([...tx.changed, ...changed])]
      tx.at = Date.now()
      prev.selectionAfter = this.ui.selection
      this.redoStack = []
      this.log = this.log.map((l) =>
        l.id === tx.id ? { ...l, changed: tx.changed, at: tx.at } : l)
      if (source === 'ai') this.setUi({ aiChanged: changed })
      this.commit(changed)
      for (const fn of this.txListeners) fn(tx)
      return tx
    }
    const tx: Transaction = { id: genId('tx'), label, source, ops, inverse, changed, at: Date.now() }
    this.undoStack.push({ tx, selectionBefore, selectionAfter: this.ui.selection, mergeKey: opts?.mergeKey })
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

  /** Revert the latest transaction. Returns its label + reverted node ids, or null when the stack is empty. */
  undo(): { label: string; changed: NodeId[] } | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    const { doc, changed } = applyOps(this.doc, entry.tx.inverse)
    this.doc = doc
    this.redoStack.push(entry)
    this.log = this.log.map((l) => (l.id === entry.tx.id ? { ...l, undone: true } : l))
    this.setSelection(entry.selectionBefore.filter((id) => this.doc.nodes[id]))
    this.commit(changed)
    return { label: entry.tx.label, changed }
  }

  /** Re-apply the latest undone transaction. Returns its label + node ids, or null when nothing to redo. */
  redo(): { label: string; changed: NodeId[] } | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    const { doc, changed } = applyOps(this.doc, entry.tx.ops)
    this.doc = doc
    this.undoStack.push(entry)
    this.log = this.log.map((l) => (l.id === entry.tx.id ? { ...l, undone: false } : l))
    this.setSelection(entry.selectionAfter.filter((id) => this.doc.nodes[id]))
    this.commit(changed)
    return { label: entry.tx.label, changed }
  }

  canUndo = () => this.undoStack.length > 0
  canRedo = () => this.redoStack.length > 0

  /** Replace the whole document (load from disk, import). Clears history. */
  replaceDocument(doc: DocumentModel) {
    // Normalize documents saved before newer model fields existed, then run
    // forward migrations (e.g. v1→v2 wraps component sets into real frames).
    this.doc = migrateDocument({
      ...doc,
      tokens: doc.tokens ?? {},
      fonts: doc.fonts ?? {},
      assets: doc.assets ?? {},
      componentSets: doc.componentSets ?? {},
      comments: doc.comments ?? [],
    })
    this.undoStack = []
    this.redoStack = []
    this.setUi({
      selection: [], hoverId: null, editingTextId: null, aiChanged: [],
      activeCommentId: null, commentDraft: null,
    })
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

  /** Rename the document. Not undoable; reaches persistence via doc listeners. */
  setDocName(name: string) {
    if (this.doc.name === name) return
    this.doc = { ...this.doc, name }
    this.docVersion++
    for (const fn of this.docListeners) fn()
  }

  /** Switch the visible page. Not undoable — it's view state, like camera. */
  setActivePage(id: string) {
    if (this.doc.activePageId === id || !this.doc.pages.some((p) => p.id === id)) return
    this.doc = { ...this.doc, activePageId: id }
    this.setUi({
      selection: [], hoverId: null, editingTextId: null, aiChanged: [],
      activeCommentId: null, commentDraft: null,
    })
    this.docVersion++
    for (const fn of this.docListeners) fn()
  }

  // --- Comments ------------------------------------------------------------
  // Comment threads are a side channel: a conversation log, not a design edit.
  // They persist on the document (so autosave/reload carry them) but bypass the
  // undo/redo op system — replying or resolving must not be Ctrl+Z-able, and an
  // agent's MCP reply must never land on the user's undo stack. Each mutation
  // replaces doc.comments, bumps docVersion, and notifies doc subscribers (the
  // canvas pins, the comments panel, and autosave).

  private comments(): CommentThread[] {
    return this.doc.comments ?? []
  }

  private commitComments(comments: CommentThread[]) {
    this.doc = { ...this.doc, comments }
    this.docVersion++
    for (const fn of this.docListeners) fn()
  }

  /** Create a thread anchored at (x,y) on a page with one opening message. */
  addCommentThread(input: {
    x: number
    y: number
    nodeIds?: NodeId[]
    area?: CommentRect
    pageId?: string
    author?: CommentAuthor
    body: string
  }): CommentThread {
    const now = Date.now()
    const thread: CommentThread = {
      id: genId('cmt'),
      pageId: input.pageId ?? this.doc.activePageId,
      x: input.x,
      y: input.y,
      nodeIds: input.nodeIds ?? [],
      ...(input.area ? { area: input.area } : {}),
      messages: [{ id: genId('msg'), author: input.author ?? 'user', body: input.body, createdAt: now }],
      resolved: false,
      createdAt: now,
    }
    this.commitComments([...this.comments(), thread])
    return thread
  }

  getCommentThread(id: string): CommentThread | null {
    return this.comments().find((t) => t.id === id) ?? null
  }

  /** Append a reply. `reopen` (default true) clears resolved on a new message. */
  addCommentMessage(
    threadId: string,
    body: string,
    author: CommentAuthor = 'user',
    opts?: { reopen?: boolean },
  ): CommentMessage | null {
    const thread = this.getCommentThread(threadId)
    if (!thread) return null
    const message: CommentMessage = { id: genId('msg'), author, body, createdAt: Date.now() }
    const reopen = opts?.reopen ?? true
    const next = this.comments().map((t) =>
      t.id === threadId
        ? { ...t, messages: [...t.messages, message], resolved: reopen ? false : t.resolved }
        : t,
    )
    this.commitComments(next)
    return message
  }

  /** Edit a message's body in place (author check is the caller's concern). */
  editCommentMessage(threadId: string, messageId: string, body: string): boolean {
    const thread = this.getCommentThread(threadId)
    if (!thread || !thread.messages.some((m) => m.id === messageId)) return false
    const next = this.comments().map((t) =>
      t.id === threadId
        ? {
            ...t,
            messages: t.messages.map((m) =>
              m.id === messageId ? { ...m, body, editedAt: Date.now() } : m,
            ),
          }
        : t,
    )
    this.commitComments(next)
    return true
  }

  setCommentResolved(threadId: string, resolved: boolean): boolean {
    const thread = this.getCommentThread(threadId)
    if (!thread || thread.resolved === resolved) return false
    this.commitComments(this.comments().map((t) => (t.id === threadId ? { ...t, resolved } : t)))
    return true
  }

  deleteCommentThread(threadId: string): boolean {
    if (!this.getCommentThread(threadId)) return false
    this.commitComments(this.comments().filter((t) => t.id !== threadId))
    if (this.ui.activeCommentId === threadId) this.setUi({ activeCommentId: null })
    return true
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
