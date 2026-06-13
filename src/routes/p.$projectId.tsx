import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CanvasRoot } from '#/editor/canvas/CanvasRoot'
import { CommentLayer } from '#/editor/canvas/CommentLayer'
import { cameraStore } from '#/editor/canvas/camera'
import { startBridge } from '#/editor/ai/bridgeClient'
import '#/editor/iconResolver'
import { startFontSync } from '#/editor/fonts'
import { editorStore } from '#/editor/store/editorStore'
import { startAutosave } from '#/editor/store/persistence'
import { startThumbnailCapture } from '#/editor/thumbnail'
import { Inspector } from '#/editor/ui/Inspector'
import { LeftPanel } from '#/editor/ui/LeftPanel'
import { Toolbar } from '#/editor/ui/Toolbar'
import { TopBar } from '#/editor/ui/TopBar'
import { getProject } from '#/server/projectFns'

export const Route = createFileRoute('/p/$projectId')({
  // The editor is a pure client app over browser APIs (DOM geometry,
  // pointer events); SSR would only render an empty shell.
  ssr: false,
  component: EditorPage,
})

function EditorPage() {
  const { projectId } = Route.useParams()
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void getProject({ data: { id: projectId } }).then((doc) => {
      if (cancelled) return
      if (!doc) {
        setState('missing')
        return
      }
      editorStore.replaceDocument(doc)
      setState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    if (state !== 'ready') return
    const stopAutosave = startAutosave(editorStore, projectId)
    const stopThumbnails = startThumbnailCapture(editorStore, projectId)
    const stopBridge = startBridge(projectId)
    const stopFonts = startFontSync(editorStore)
    return () => {
      stopAutosave()
      stopThumbnails()
      stopBridge()
      stopFonts()
    }
  }, [state, projectId])

  // Runtime Tailwind engine: AI/user-authored utility classes on canvas
  // nodes compile on the fly (the build-time CSS only covers app chrome).
  useEffect(() => {
    void import('@tailwindcss/browser')
  }, [])

  // Test/debug hook (Playwright asserts against the live store).
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__canvazz = {
      editorStore,
      cameraStore,
      projectId,
    }
  }, [projectId])

  if (state === 'missing') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[var(--cz-canvas-bg)] text-sm text-[var(--cz-panel-muted)]">
        <span>This file does not exist (or was deleted).</span>
        <Link to="/" className="text-[var(--cz-accent)] hover:underline">
          Back to files
        </Link>
      </div>
    )
  }

  if (state === 'loading') {
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
            <CommentLayer />
            <Toolbar />
          </div>
          <Inspector />
        </div>
      </div>
    </TooltipProvider>
  )
}
