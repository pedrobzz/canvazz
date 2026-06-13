import {
  Circle, Component, Frame, Hand, Hexagon, MessageCircle, Minus, MousePointer2,
  Redo2, Slash, Sparkles, Square, Star, Type, Undo2,
} from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cameraStore } from '../canvas/camera'
import { controllerRef } from '../canvas/CanvasRoot'
import { editorStore } from '../store/editorStore'
import { useUi } from '../store/hooks'
import { createMainComponent } from '../components/componentCommands'
import type { Tool } from '../store/editorStore'

const TOOLS: Array<{ tool: Tool; icon: typeof Square; label: string; key: string }> = [
  { tool: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { tool: 'hand', icon: Hand, label: 'Hand', key: 'H' },
  { tool: 'frame', icon: Frame, label: 'Frame', key: 'F' },
  { tool: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
  { tool: 'line', icon: Minus, label: 'Line', key: 'L' },
  { tool: 'polygon', icon: Hexagon, label: 'Polygon', key: 'P' },
  { tool: 'star', icon: Star, label: 'Star', key: 'S' },
  { tool: 'text', icon: Type, label: 'Text', key: 'T' },
  { tool: 'comment', icon: MessageCircle, label: 'Comment', key: 'C' },
]

function ToolButton({ tool, icon: Icon, label, keyLabel }: {
  tool: Tool
  icon: typeof Square
  label: string
  keyLabel: string
}) {
  const ui = useUi()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={ui.tool === tool}
          data-tool={tool}
          className={
            ui.tool === tool
              ? 'bg-[var(--cz-accent)] text-white hover:bg-[var(--cz-accent)] hover:text-white'
              : 'text-[var(--cz-panel-fg)] hover:bg-[var(--cz-panel-hover)] hover:text-white'
          }
          onClick={() => editorStore.setTool(tool)}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label} <kbd className="ml-1 opacity-60">{keyLabel}</kbd>
      </TooltipContent>
    </Tooltip>
  )
}

function useCameraScale() {
  return useSyncExternalStore(
    (fn) => cameraStore.subscribe(fn),
    () => cameraStore.camera.scale,
    () => 1,
  )
}

export function Toolbar() {
  const scale = useCameraScale()
  const ui = useUi()
  const docVersion = useSyncExternalStore(
    editorStore.subscribeDoc,
    () => editorStore.docVersion,
    () => 0,
  )
  void docVersion // re-render for undo/redo enabled state

  return (
    <div
      data-cz-ui
      data-testid="toolbar"
      className="cz-panel pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-[var(--cz-panel-border)] p-1 shadow-xl"
    >
      {TOOLS.map(({ tool, icon, label, key }) => (
        <ToolButton key={tool} tool={tool} icon={icon} label={label} keyLabel={key} />
      ))}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Create component"
            className="text-[var(--cz-panel-fg)] hover:bg-[var(--cz-panel-hover)] hover:text-white"
            onClick={() => createMainComponent({ store: editorStore }, editorStore.ui.selection)}
            disabled={ui.selection.length !== 1}
          >
            <Component className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Create component from selection</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="AI assistant"
            aria-pressed={ui.tool === 'ai'}
            className={
              ui.tool === 'ai'
                ? 'bg-[var(--cz-ai)] text-white hover:bg-[var(--cz-ai)] hover:text-white'
                : 'text-[var(--cz-ai)] hover:bg-[var(--cz-panel-hover)]'
            }
            onClick={() => editorStore.setTool(ui.tool === 'ai' ? 'select' : 'ai')}
          >
            <Sparkles className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">AI panel — connect via MCP</TooltipContent>
      </Tooltip>

      <div className="mx-1 h-5 w-px bg-[var(--cz-panel-border)]" />

      <Button
        variant="ghost" size="icon" aria-label="Undo"
        className="text-[var(--cz-panel-fg)] hover:bg-[var(--cz-panel-hover)] hover:text-white disabled:opacity-30"
        disabled={!editorStore.canUndo()}
        onClick={() => editorStore.undo()}
      >
        <Undo2 className="size-4" />
      </Button>
      <Button
        variant="ghost" size="icon" aria-label="Redo"
        className="text-[var(--cz-panel-fg)] hover:bg-[var(--cz-panel-hover)] hover:text-white disabled:opacity-30"
        disabled={!editorStore.canRedo()}
        onClick={() => editorStore.redo()}
      >
        <Redo2 className="size-4" />
      </Button>

      <div className="mx-1 h-5 w-px bg-[var(--cz-panel-border)]" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            data-testid="zoom-menu"
            className="h-9 px-2 text-xs tabular-nums text-[var(--cz-panel-fg)] hover:bg-[var(--cz-panel-hover)] hover:text-white"
          >
            {Math.round(scale * 100)}%
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="cz-panel border-[var(--cz-panel-border)]">
          <DropdownMenuItem onClick={() => controllerRef.current?.zoomTo(1)}>
            Zoom to 100% <kbd className="ml-auto opacity-50">⌘0</kbd>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => controllerRef.current?.zoomToFit()}>
            Zoom to fit <kbd className="ml-auto opacity-50">⌘1</kbd>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => controllerRef.current?.zoomToSelection()}>
            Zoom to selection <kbd className="ml-auto opacity-50">⌘2</kbd>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editorStore.setUi({ showGrid: !ui.showGrid })}>
            {ui.showGrid ? 'Hide grid' : 'Show grid'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editorStore.setUi({ snapping: !ui.snapping })}>
            {ui.snapping ? 'Disable snapping' : 'Enable snapping'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" aria-hidden>
        <Slash />
      </span>
    </div>
  )
}
