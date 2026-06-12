import { saveProject } from '#/server/projectFns'
import type { DocumentModel } from '../model/types'

/**
 * Document persistence: the open project autosaves (debounced) through a
 * server function into the libSQL store at ~/.canvazz/database.db. Projects
 * metadata lives in the TanStack DB collection (lib/projectsCollection).
 */

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

/** Wire autosave to a store: debounced save on every doc change. */
export function startAutosave(
  store: { subscribeDoc: (fn: () => void) => () => void; doc: DocumentModel },
  projectId: string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    saveProject({ data: { id: projectId, doc: store.doc } })
      .then(() => setSaveState('saved'))
      .catch((err) => {
        console.error('Autosave failed:', err)
        setSaveState('error')
      })
  }
  const unsub = store.subscribeDoc(() => {
    if (timer) clearTimeout(timer)
    setSaveState('saving')
    timer = setTimeout(save, 600)
  })
  return () => {
    unsub()
    // Flush a pending save so navigating away never drops the last edit.
    if (timer) {
      clearTimeout(timer)
      save()
    }
  }
}

/**
 * One-time migration from the pre-multi-project IndexedDB store: pull the
 * single saved document out so the Files page can import it as a project,
 * then drop it. Resolves null when there is nothing to migrate.
 */
export async function takeLegacyDocument(): Promise<DocumentModel | null> {
  if (typeof indexedDB === 'undefined') return null
  const databases = await indexedDB.databases?.()
  if (databases && !databases.some((d) => d.name === 'canvazz')) return null
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('canvazz', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('documents')) {
          req.result.createObjectStore('documents')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    })
    const doc = await new Promise<DocumentModel | null>((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite')
      const docs = tx.objectStore('documents')
      const req = docs.get('current')
      req.onsuccess = () => {
        resolve((req.result as DocumentModel | undefined) ?? null)
        docs.delete('current')
      }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'))
    })
    db.close()
    return doc
  } catch (err) {
    console.error('Legacy document migration failed:', err)
    return null
  }
}
