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

  private tick(e: PointerEvent) {
    const g = this.gesture
    const camera = cameraStore.camera
    switch (g.type) {
      case 'pan': {
        cameraStore.panBy(e.clientX - g.lastX, e.clientY - g.lastY)
        this.gesture = { ...g, lastX: e.clientX, lastY: e.clientY }
        break
      }
      case 'marquee': {
        const v = this.viewport.getBoundingClientRect()
        const rect: Rect = {
          x: Math.min(g.startX, e.clientX) - v.left,
          y: Math.min(g.startY, e.clientY) - v.top,
          width: Math.abs(e.clientX - g.startX),
          height: Math.abs(e.clientY - g.startY),
        }
        this.overlay.setMarquee(rect)
        const worldRect = screenToWorldRect(rect, camera)
        const hits = this.marqueeHits(worldRect)
        const next = g.additive ? [...new Set([...g.base, ...hits])] : hits
        this.store.setSelection(next)
        break
      }
      case 'drag': {
        const scale = camera.scale
        let dx = (e.clientX - g.startClientX) / scale
        let dy = (e.clientY - g.startClientY) / scale
        if (!g.moved && Math.hypot(dx * scale, dy * scale) < 3) return
        g.moved = true
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        let guides: SnapGuide[] = []
        if (this.store.ui.snapping && !e.metaKey) {
          const moving = unionRects(g.startRects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })))
          if (moving) {
            const snapped = snapRect(moving, g.snapTargets, 8 / scale)
            dx += snapped.dx
            dy += snapped.dy
            guides = snapped.guides
          }
        }
        if (this.store.ui.showGrid && e.altKey) {
          dx = Math.round(dx / 8) * 8
          dy = Math.round(dy / 8) * 8
        }
        for (const item of g.items) {
          item.el.style.left = fmtPx(item.left + dx)
          item.el.style.top = fmtPx(item.top + dy)
        }
        this.overlay.setGuides(guides)
        // Highlight prospective drop container.
        const drop = this.dropTargetAt(e, g.items.map((i) => i.id))
        g.dropTarget = drop?.id ?? null
        break
      }
      case 'resize': {
        const scale = camera.scale
        const dx = (e.clientX - g.startClientX) / scale
        const dy = (e.clientY - g.startClientY) / scale
        const u = g.union
        let x1 = u.x, y1 = u.y, x2 = u.x + u.width, y2 = u.y + u.height
        if (g.dir.includes('w')) x1 += dx
        if (g.dir.includes('e')) x2 += dx
        if (g.dir.includes('n')) y1 += dy
        if (g.dir.includes('s')) y2 += dy
        if (e.altKey || g.centerMode) {
          if (g.dir.includes('w')) x2 = u.x + u.width - (x1 - u.x)
          if (g.dir.includes('e')) x1 = u.x - (x2 - (u.x + u.width))
          if (g.dir.includes('n')) y2 = u.y + u.height - (y1 - u.y)
          if (g.dir.includes('s')) y1 = u.y - (y2 - (u.y + u.height))
        }
        if (e.shiftKey && u.width > 0 && u.height > 0) {
          const aspect = u.width / u.height
          const w = x2 - x1
          const h = y2 - y1
          if (Math.abs(w / Math.max(h, 0.01)) > aspect === (g.dir === 'n' || g.dir === 's')) {
            // grow the lagging axis
          }
          if (g.dir === 'n' || g.dir === 's') {
            const newW = h * aspect
            const cx = (x1 + x2) / 2
            x1 = cx - newW / 2
            x2 = cx + newW / 2
          } else if (g.dir === 'e' || g.dir === 'w') {
            const newH = w / aspect
            const cy = (y1 + y2) / 2
            y1 = cy - newH / 2
            y2 = cy + newH / 2
          } else {
            const newH = w / aspect
            if (g.dir.includes('n')) y1 = y2 - newH
            else y2 = y1 + newH
          }
        }
        const newUnion: Rect = {
          x: Math.min(x1, x2), y: Math.min(y1, y2),
          width: Math.max(1, Math.abs(x2 - x1)), height: Math.max(1, Math.abs(y2 - y1)),
        }
        const fx = newUnion.width / Math.max(u.width, 0.01)
        const fy = newUnion.height / Math.max(u.height, 0.01)
        for (const item of g.items) {
          const r = item.rect
          const nx = newUnion.x + (r.x - u.x) * fx
          const ny = newUnion.y + (r.y - u.y) * fy
          item.el.style.left = fmtPx(nx)
          item.el.style.top = fmtPx(ny)
          item.el.style.width = fmtPx(Math.max(1, r.width * fx))
          item.el.style.height = fmtPx(Math.max(1, r.height * fy))
        }
        const screen = this.viewport.getBoundingClientRect()
        this.overlay.setSizeBadge(
          { x: e.clientX - screen.left, y: e.clientY - screen.top + 24 },
          `${Math.round(newUnion.width)} × ${Math.round(newUnion.height)}`,
        )
        break
      }
      case 'rotate': {
        const angle =
          (Math.atan2(e.clientY - g.centerY, e.clientX - g.centerX) * 180) / Math.PI
        let next = g.base + (angle - g.startAngle)
        if (e.shiftKey) next = Math.round(next / 15) * 15
        next = ((next % 360) + 360) % 360
        g.el.style.rotate = `${Math.round(next * 10) / 10}deg`
        const screen = this.viewport.getBoundingClientRect()
        this.overlay.setSizeBadge(
          { x: e.clientX - screen.left, y: e.clientY - screen.top + 24 },
          `${Math.round(next)}°`,
        )
        break
      }
      case 'draw': {
        const world = this.toWorld(e)
        const rect: Rect = {
          x: Math.min(g.startWorldX, world.x), y: Math.min(g.startWorldY, world.y),
          width: Math.abs(world.x - g.startWorldX), height: Math.abs(world.y - g.startWorldY),
        }
        if (e.shiftKey) {
          const side = Math.max(rect.width, rect.height)
          rect.width = side
          rect.height = side
        }
        const camera2 = cameraStore.camera
        this.overlay.setMarquee({
          x: rect.x * camera2.scale + camera2.x,
          y: rect.y * camera2.scale + camera2.y,
          width: rect.width * camera2.scale,
          height: rect.height * camera2.scale,
        })
        this.overlay.setSizeBadge(
          { x: e.clientX - this.viewport.getBoundingClientRect().left, y: e.clientY - this.viewport.getBoundingClientRect().top + 24 },
          `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
        )
        break
      }
      case 'idle':
        break
    }
  }
}
