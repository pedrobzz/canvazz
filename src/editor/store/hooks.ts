import { useSyncExternalStore } from 'react'
import { editorStore } from './editorStore'
import type { NodeId } from '../model/types'

/** Re-renders only when this specific node changes (or is removed). */
export function useNode(id: NodeId) {
  return useSyncExternalStore(
    editorStore.subscribeNode(id),
    () => editorStore.getNode(id),
    () => editorStore.getNode(id),
  )
}

/** Re-renders on any document change; read `editorStore.doc` in render. */
export function useDocVersion() {
  return useSyncExternalStore(
    editorStore.subscribeDoc,
    () => editorStore.docVersion,
    () => editorStore.docVersion,
  )
}

/** UI state slice (tool, selection, hover, text editing, toggles). */
export function useUi() {
  return useSyncExternalStore(
    editorStore.subscribeUi,
    () => editorStore.ui,
    () => editorStore.ui,
  )
}
