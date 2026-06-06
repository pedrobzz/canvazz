import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CanvasRoot } from '#/editor/canvas/CanvasRoot'
import { startBridge } from '#/editor/ai/bridgeClient'
import { editorStore } from '#/editor/store/editorStore'
import { loadDocument, seedDocument, startAutosave } from '#/editor/store/persistence'
import { Inspector } from '#/editor/ui/Inspector'
import { LeftPanel } from '#/editor/ui/LeftPanel'
import { Toolbar } from '#/editor/ui/Toolbar'
import { TopBar } from '#/editor/ui/TopBar'

export const Route = createFileRoute('/')({
  // The editor is a pure client app over browser APIs (DOM geometry,
  // IndexedDB, pointer events); SSR would only render an empty shell.
  ssr: false,
  component: EditorPage,
})

function EditorPage() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadDocument().then((saved) => {
      if (cancelled) return
      editorStore.replaceDocument(saved ?? seedDocument())
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    const stopAutosave = startAutosave(editorStore)
    const stopBridge = startBridge()
    return () => {
      stopAutosave()
      stopBridge()
    }
  }, [ready])
  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--cz-canvas-bg)] text-sm text-[var(--cz-panel-muted)]">
        Loading document…
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col overflow-hidden bg-[var(--cz-canvas-bg)]">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <LeftPanel />
          <div className="relative min-w-0 flex-1">
            <CanvasRoot />
            <Toolbar />
          </div>
          <Inspector />
        </div>
      </div>
    </TooltipProvider>
  )
}
