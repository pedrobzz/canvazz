import { emptyDocument } from '../model/doc'
import { genId } from '../model/ids'
import type { DocumentModel } from '../model/types'

/**
 * Local-first persistence: the document autosaves to IndexedDB (debounced)
 * and restores on load. No network required; Convex/multiplayer can layer on
 * top later by syncing the same document model.
 */

const DB_NAME = 'canvazz'
const STORE = 'documents'
const CURRENT_KEY = 'current'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

type SaveListener = (state: SaveState) => void
const listeners = new Set<SaveListener>()
let saveState: SaveState = 'idle'

export function subscribeSaveState(fn: SaveListener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSaveState() {
  return saveState
}

function setSaveState(state: SaveState) {
  saveState = state
  for (const fn of listeners) fn(state)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

export async function loadDocument(): Promise<DocumentModel | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(CURRENT_KEY)
      req.onsuccess = () => resolve((req.result as DocumentModel | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'))
    })
  } catch (err) {
    console.error('Failed to load document from IndexedDB:', err)
    return null
  }
}

export async function saveDocument(doc: DocumentModel): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(doc, CURRENT_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}
