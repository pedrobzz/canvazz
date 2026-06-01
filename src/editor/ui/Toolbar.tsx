import {
  Circle, Component, Frame, Hand, Hexagon, Minus, MessageSquare, MousePointer2,
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
  { tool: 'comment', icon: MessageSquare, label: 'Comment', key: 'C' },
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
