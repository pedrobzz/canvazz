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
}
