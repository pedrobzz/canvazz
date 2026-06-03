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
