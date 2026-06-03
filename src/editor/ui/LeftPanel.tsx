import { useSyncExternalStore } from 'react'
import { Component, Layers, ScrollText, Sparkles, User } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cameraStore } from '../canvas/camera'
import { createInstance } from '../components/componentCommands'
import { editorStore } from '../store/editorStore'
import { useDocVersion } from '../store/hooks'
import { LayerTree } from './LayerTree'

export function LeftPanel() {
  return (
    <div
      data-cz-ui
      className="cz-panel flex h-full w-60 shrink-0 flex-col border-r border-[var(--cz-panel-border)]"
    >
      <Tabs defaultValue="layers" className="flex h-full min-h-0 flex-col gap-0">
        <TabsList className="m-2 grid w-auto grid-cols-3 bg-[var(--cz-panel-hover)]">
          <TabsTrigger value="layers" className="text-[11px] data-[state=active]:bg-[var(--cz-panel-active)] data-[state=active]:text-white">
            <Layers className="size-3" /> Layers
          </TabsTrigger>
          <TabsTrigger value="components" className="text-[11px] data-[state=active]:bg-[var(--cz-panel-active)] data-[state=active]:text-white">
            <Component className="size-3" /> Assets
          </TabsTrigger>
          <TabsTrigger value="log" className="text-[11px] data-[state=active]:bg-[var(--cz-panel-active)] data-[state=active]:text-white">
            <ScrollText className="size-3" /> Log
          </TabsTrigger>
        </TabsList>
        <TabsContent value="layers" className="flex min-h-0 flex-1 flex-col">
          <LayerTree />
        </TabsContent>
        <TabsContent value="components" className="min-h-0 flex-1 overflow-y-auto">
          <ComponentList />
        </TabsContent>
        <TabsContent value="log" className="min-h-0 flex-1 overflow-y-auto">
          <CommandLog />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ComponentList() {
  useDocVersion()
  const components = Object.values(editorStore.doc.components)
  if (components.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--cz-panel-muted)]">
        No components yet. Select a layer and press the ⬦ button in the toolbar to create one.
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {components.map((def) => (
        <li key={def.id}>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] hover:bg-[var(--cz-panel-hover)]"
            title="Insert instance at canvas center"
            onClick={() => {
              const page = editorStore.activePage()
              const viewport = document.querySelector('[data-canvas]')
              const v = viewport?.getBoundingClientRect()
              const center = v
                ? cameraStore.screenToWorld(v.width / 2, v.height / 2)
                : { x: 0, y: 0 }
              const artboard = page.children.find((id) => editorStore.doc.nodes[id]?.isArtboard)
              const at = artboard
                ? ({ kind: 'node', parent: artboard, index: editorStore.doc.nodes[artboard].children.length } as const)
                : ({ kind: 'page', pageId: page.id, index: page.children.length } as const)
              const offset = artboard
                ? {
                    x: center.x - (parseFloat(editorStore.doc.nodes[artboard].style.left ?? '0') || 0),
                    y: center.y - (parseFloat(editorStore.doc.nodes[artboard].style.top ?? '0') || 0),
                  }
                : center
              const id = createInstance({ store: editorStore }, def.id, at, offset)
              if (id) editorStore.setSelection([id])
            }}
          >
            <Component className="size-3 shrink-0 text-[var(--cz-ai)]" />
            <span className="truncate">{def.name}</span>
            {def.variantProps?.variant ? (
              <span className="ml-auto text-[10px] text-[var(--cz-panel-muted)]">{def.variantProps.variant}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Reviewable command log: every transaction, who made it, what changed. */
function CommandLog() {
  const log = useSyncExternalStore(
    editorStore.subscribeDoc,
    () => editorStore.log,
    () => editorStore.log,
  )
  if (log.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-[var(--cz-panel-muted)]">No edits yet.</div>
  }
  return (
    <ul className="flex flex-col-reverse gap-0.5 p-2" data-testid="command-log">
      {log.map((entry) => (
        <li key={entry.id}>
          <button
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-[var(--cz-panel-hover)] ${entry.undone ? 'opacity-40 line-through' : ''}`}
            title={`${entry.changed.length} node(s) changed — click to select`}
            onClick={() => {
              const alive = entry.changed.filter((id) => editorStore.doc.nodes[id])
              if (alive.length > 0) editorStore.setSelection(alive)
            }}
          >
            {entry.source === 'ai' ? (
              <Sparkles className="size-3 shrink-0 text-[var(--cz-ai)]" />
            ) : (
              <User className="size-3 shrink-0 text-[var(--cz-panel-muted)]" />
            )}
            <span className="truncate">{entry.label}</span>
            <span className="ml-auto shrink-0 text-[9px] tabular-nums text-[var(--cz-panel-muted)]">
              {new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
