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

  // --- Pointer -------------------------------------------------------------

  private onPointerDown(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest('[data-cz-ui]')) return
    const { store } = this
    if (store.ui.editingTextId) {
      const hit = this.pickPathId(e)
      if (hit === store.ui.editingTextId) return // typing inside the text node
      this.commitTextEdit()
    }

    // Pan: middle button, space+left, or hand tool.
    if (e.button === 1 || (e.button === 0 && (this.spaceDown || store.ui.tool === 'hand'))) {
      this.gesture = { type: 'pan', lastX: e.clientX, lastY: e.clientY }
      this.viewport.setPointerCapture(e.pointerId)
      this.setCursor('grabbing')
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const tool = store.ui.tool

    if (SHAPE_TOOLS.has(tool)) {
      this.startDraw(e, tool)
      return
    }

    if (tool === 'comment') {
      const world = this.toWorld(e)
      store.apply('Add comment', [{
        t: 'addComment',
        comment: {
          id: `c_${Date.now().toString(36)}`, nodeId: null, x: world.x, y: world.y,
          author: 'You', body: '', createdAt: Date.now(), resolved: false,
        },
      }])
      store.setTool('select')
      return
    }

    // Select tool. Resize/rotate handles first (they live in the overlay).
    const handle = (e.target as Element).closest?.('[data-handle]')
    if (handle instanceof HTMLElement && store.ui.selection.length > 0) {
      const dir = handle.dataset.handle
      if (dir === 'rotate') this.startRotate(e)
      else if (dir) this.startResize(e, dir)
      return
    }

    const picked = this.pickSelection(e)
    if (picked) {
      let next: NodeId[]
      if (e.shiftKey) {
        next = store.ui.selection.includes(picked)
          ? store.ui.selection.filter((id) => id !== picked)
          : [...store.ui.selection, picked]
        store.setSelection(next)
        return // shift-click adjusts selection, never starts a drag
      }
      next = store.ui.selection.includes(picked) ? store.ui.selection : [picked]
      store.setSelection(next)
      if (e.altKey) {
        const dupes = duplicateNodes({ store }, next, 0)
        if (dupes.length > 0) {
          store.setSelection(dupes)
          store.recordSelectionAfter()
          next = dupes
        }
      }
      this.startDrag(next, e)
    } else {
      this.gesture = {
        type: 'marquee', startX: e.clientX, startY: e.clientY,
        additive: e.shiftKey, base: e.shiftKey ? store.ui.selection : [],
      }
      if (!e.shiftKey) store.setSelection([])
      this.viewport.setPointerCapture(e.pointerId)
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (this.gesture.type === 'idle') {
      this.updateHover(e)
      return
    }
    this.lastPointer = e
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0
        if (this.lastPointer) this.tick(this.lastPointer)
      })
    }
  }

  private onPointerUp(e: PointerEvent) {
    const g = this.gesture
    this.gesture = { type: 'idle' }
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    this.overlay.setMarquee(null)
    this.overlay.setGuides([])
    this.overlay.setSizeBadge(null)
    this.overlay.setHidden(false)
    this.setCursor(this.store.ui.tool === 'hand' ? 'grab' : '')

    switch (g.type) {
      case 'drag': {
        if (!g.moved) break
        const ops: Op[] = []
        for (const { id, el } of g.items) {
          ops.push({ t: 'setStyle', id, set: { left: el.style.left, top: el.style.top } })
        }
        // Reparent if dropped over a different container.
        const drop = this.dropTargetAt(e, g.items.map((i) => i.id))
        if (drop) {
          for (const { id, el } of g.items) {
            const rect = worldRectOf(el, this.viewport, cameraStore.camera)
            const containerRect = drop.rect
            ops.push({ t: 'move', id, to: { kind: 'node', parent: drop.id, index: drop.index } })
            ops.push({
              t: 'setStyle', id,
              set: { left: fmtPx(rect.x - containerRect.x), top: fmtPx(rect.y - containerRect.y) },
            })
          }
        }
        this.store.apply('Move', ops)
        this.store.recordSelectionAfter()
        break
      }
      case 'resize': {
        const ops: Op[] = g.items.map(({ id, el }) => ({
          t: 'setStyle', id,
          set: { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height },
        }))
        this.store.apply('Resize', ops)
        break
      }
      case 'rotate': {
        this.store.apply('Rotate', [
          { t: 'setStyle', id: g.id, set: { rotate: g.el.style.rotate || null } },
        ])
        break
      }
      case 'draw': {
        this.finishDraw(g, e)
        break
      }
      case 'marquee':
        break
      case 'pan':
        break
      case 'idle':
        break
    }
  }
}
