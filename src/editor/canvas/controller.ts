import { cameraStore } from './camera'
import {
  fmtPx, nodeElement, px, rectContains, rectsIntersect,
  screenToWorldRect, snapRect, unionRects, worldRectOf,
} from './geometry'
import {
  createArtboard, createEllipse, createLine, createPolygon,
  createRectangle, createStar, createText,
} from '../model/factory'
import {
  copyNodes, deleteNodes, duplicateNodes, groupNodes, nudgeNodes,
  pasteHtml, reorderNodes, topMostOnly, ungroupNodes,
} from '../commands'
import { parsePathId } from '../model/instances'
import type { Overlay } from './overlay'
import type { Rect, SnapGuide } from './geometry'
import type { EditorStore, Tool } from '../store/editorStore'
import type { NodeId, NodeModel, Op } from '../model/types'

/**
 * Pointer/keyboard state machine. Lives entirely outside React: native
 * listeners on the viewport, direct DOM writes during gestures (the browser
 * does layout), and a single model transaction at the gesture boundary.
 */

type Gesture =
  | { type: 'idle' }
  | { type: 'pan'; lastX: number; lastY: number }
  | { type: 'marquee'; startX: number; startY: number; additive: boolean; base: NodeId[] }
  | {
      type: 'drag'
      items: Array<{ id: NodeId; el: HTMLElement; left: number; top: number }>
      startClientX: number
      startClientY: number
      moved: boolean
      snapTargets: Rect[]
      startRects: Rect[]
      dropTarget: NodeId | null
    }
  | {
      type: 'resize'
      dir: string
      items: Array<{ id: NodeId; el: HTMLElement; rect: Rect }>
      union: Rect
      startClientX: number
      startClientY: number
      centerMode: boolean
    }
  | {
      type: 'rotate'
      id: NodeId
      el: HTMLElement
      centerX: number
      centerY: number
      startAngle: number
      base: number
    }
  | {
      type: 'draw'
      tool: Tool
      startWorldX: number
      startWorldY: number
      container: { parent: NodeId | null; originX: number; originY: number }
    }

const SHAPE_TOOLS: ReadonlySet<Tool> = new Set(['frame', 'rect', 'ellipse', 'line', 'polygon', 'star', 'text'])

export class InteractionController {
  private gesture: Gesture = { type: 'idle' }
  private spaceDown = false
  private raf = 0
  private lastPointer: PointerEvent | null = null
  private disposers: Array<() => void> = []

  constructor(
    private viewport: HTMLElement,
    private world: HTMLElement,
    private store: EditorStore,
    private overlay: Overlay,
  ) {
    this.listen(viewport, 'pointerdown', this.onPointerDown)
    this.listen(window, 'pointermove', this.onPointerMove)
    this.listen(window, 'pointerup', this.onPointerUp)
    this.listen(viewport, 'wheel', this.onWheel, { passive: false })
    this.listen(window, 'keydown', this.onKeyDown)
    this.listen(window, 'keyup', this.onKeyUp)
    this.listen(viewport, 'dblclick', this.onDoubleClick)
    this.listen(viewport, 'contextmenu', (e: Event) => e.preventDefault())
  }

  destroy() {
    this.disposers.forEach((d) => d())
    if (this.raf) cancelAnimationFrame(this.raf)
  }

  private listen<K extends string>(
    target: EventTarget,
    type: K,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions,
  ) {
    const bound = fn.bind(this) as EventListener
    target.addEventListener(type, bound, opts)
    this.disposers.push(() => target.removeEventListener(type, bound, opts))
  }

  /** Used by the overlay's artboard labels to start a drag on the artboard. */
  artboardLabelPointerDown = (id: NodeId, e: PointerEvent) => {
    this.store.setSelection([id])
    this.startDrag([id], e)
  }
}
