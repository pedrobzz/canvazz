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
  canReceiveChildren, copyNodes, deleteNodes, duplicateNodes, groupNodes,
  isSvgNode, isTextNode, nudgeNodes, pasteHtml, reorderNodes, topMostOnly,
  ungroupNodes,
} from '../commands'
import { clipboard, setClipboard } from '../clipboard'
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
      items: Array<DragItem>
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
      items: Array<{ id: NodeId; el: HTMLElement; rect: Rect; mode: 'abs' | 'flow' }>
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
      container: DrawContainer
    }

/**
 * Dragged node. Absolutely-positioned nodes move via left/top; flow children
 * of auto-layout containers move via an ephemeral transform and commit as a
 * reorder/reparent on drop.
 */
interface DragItem {
  id: NodeId
  el: HTMLElement
  mode: 'abs' | 'flow'
  left: number
  top: number
}

interface DrawContainer {
  parent: NodeId | null
  originX: number
  originY: number
  flex: boolean
  index: number
}

/** Where a drag would land if released now. */
type DropInfo =
  | { kind: 'flex'; id: NodeId; rect: Rect; index: number; guide: SnapGuide }
  | { kind: 'abs'; id: NodeId; rect: Rect; index: number }
  | { kind: 'page'; index: number }
  | null

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
        if (!g.moved) {
          for (const item of g.items) if (item.mode === 'flow') item.el.style.transform = ''
          break
        }
        const camera = cameraStore.camera
        const drop = this.dropInfoAt(e, g.items.map((i) => i.id))
        const ops: Op[] = []
        for (const item of g.items) {
          const finalRect = worldRectOf(item.el, this.viewport, camera)
          if (item.mode === 'flow') item.el.style.transform = ''
          const node = this.store.doc.nodes[item.id]
          if (!node) continue
          if (drop?.kind === 'flex') {
            // Join the auto-layout flow at the computed index.
            ops.push({ t: 'move', id: item.id, to: { kind: 'node', parent: drop.id, index: drop.index } })
            if (node.style.position || node.style.left || node.style.top) {
              ops.push({ t: 'setStyle', id: item.id, set: { position: null, left: null, top: null } })
            }
          } else if (drop?.kind === 'abs') {
            ops.push({ t: 'move', id: item.id, to: { kind: 'node', parent: drop.id, index: drop.index } })
            ops.push({
              t: 'setStyle', id: item.id,
              set: {
                position: 'absolute',
                left: fmtPx(finalRect.x - drop.rect.x),
                top: fmtPx(finalRect.y - drop.rect.y),
              },
            })
          } else if (drop?.kind === 'page') {
            const page = this.store.activePage()
            ops.push({ t: 'move', id: item.id, to: { kind: 'page', pageId: page.id, index: drop.index } })
            ops.push({
              t: 'setStyle', id: item.id,
              set: { position: 'absolute', left: fmtPx(finalRect.x), top: fmtPx(finalRect.y) },
            })
          } else if (item.mode === 'abs') {
            ops.push({ t: 'setStyle', id: item.id, set: { left: item.el.style.left, top: item.el.style.top } })
          }
          // Flow item with nowhere to land snaps back (transform cleared).
        }
        this.store.apply('Move', ops)
        this.store.recordSelectionAfter()
        break
      }
      case 'resize': {
        const ops: Op[] = g.items.map(({ id, el, mode }) => {
          const set: Record<string, string | null> =
            mode === 'abs'
              ? { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }
              : // Explicit size replaces fill/hug behavior, like Figma.
                { width: el.style.width, height: el.style.height, 'flex-grow': null, 'flex-basis': null }
          return { t: 'setStyle', id, set }
        })
        for (const item of g.items) {
          if (item.mode === 'flow') {
            item.el.style.flexGrow = ''
            item.el.style.flexBasis = ''
          }
        }
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
          if (item.mode === 'abs') {
            item.el.style.left = fmtPx(item.left + dx)
            item.el.style.top = fmtPx(item.top + dy)
          } else {
            item.el.style.transform = `translate(${fmtPx(dx)}, ${fmtPx(dy)})`
          }
        }
        // Prospective drop container; flex targets show an insertion line.
        const drop = this.dropInfoAt(e, g.items.map((i) => i.id))
        g.dropTarget = drop && drop.kind !== 'page' ? drop.id : null
        if (drop?.kind === 'flex') guides = [...guides, drop.guide]
        this.overlay.setGuides(guides)
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
          if (item.mode === 'abs') {
            item.el.style.left = fmtPx(newUnion.x + (r.x - u.x) * fx)
            item.el.style.top = fmtPx(newUnion.y + (r.y - u.y) * fy)
          } else {
            // Hand-resizing a flow child pins it to a fixed size live.
            item.el.style.flexGrow = '0'
            item.el.style.flexBasis = 'auto'
          }
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

  // --- Gesture starters ----------------------------------------------------

  private startDrag(ids: NodeId[], e: PointerEvent) {
    const camera = cameraStore.camera
    const items: Array<DragItem> = []
    const roots = topMostOnly(this.store, ids)
    for (const id of roots) {
      const node = this.store.doc.nodes[id]
      const el = nodeElement(this.world, id)
      if (!node || !el || node.locked) continue
      const left = px(node.style.left)
      const top = px(node.style.top)
      if (left !== null && top !== null) {
        items.push({ id, el, mode: 'abs', left, top })
      } else {
        // Flow child (auto-layout): drag via transform, commit as reorder.
        items.push({ id, el, mode: 'flow', left: 0, top: 0 })
      }
    }
    if (items.length === 0) return
    const startRects = items.map(({ el }) => worldRectOf(el, this.viewport, camera))
    this.gesture = {
      type: 'drag', items, startClientX: e.clientX, startClientY: e.clientY,
      moved: false, snapTargets: this.snapTargetsFor(items.map((i) => i.id)),
      startRects, dropTarget: null,
    }
    this.viewport.setPointerCapture(e.pointerId)
  }

  private startResize(e: PointerEvent, dir: string) {
    const camera = cameraStore.camera
    const items: Array<{ id: NodeId; el: HTMLElement; rect: Rect; mode: 'abs' | 'flow' }> = []
    for (const pathId of topMostOnly(this.store, this.store.ui.selection)) {
      // Instance internals resize via overrides in the inspector, not handles.
      if (pathId.includes(':')) continue
      const { sourceId } = parsePathId(pathId)
      const node = this.store.doc.nodes[sourceId]
      const el = nodeElement(this.world, pathId)
      if (!node || !el || node.locked) continue
      const left = px(node.style.left)
      const top = px(node.style.top)
      // SVGElement has no offsetWidth; derive size from the live rect.
      const world = worldRectOf(el, this.viewport, camera)
      const w = el instanceof HTMLElement ? el.offsetWidth : world.width
      const h = el instanceof HTMLElement ? el.offsetHeight : world.height
      if (left !== null && top !== null) {
        items.push({ id: sourceId, el, mode: 'abs', rect: { x: left, y: top, width: w, height: h } })
      } else {
        // Flow child: resizing sets explicit width/height (no position).
        items.push({ id: sourceId, el, mode: 'flow', rect: { x: 0, y: 0, width: w, height: h } })
      }
    }
    if (items.length === 0) return
    const union = unionRects(items.map((i) => i.rect))
    if (!union) return
    this.gesture = {
      type: 'resize', dir, items, union,
      startClientX: e.clientX, startClientY: e.clientY, centerMode: false,
    }
    this.viewport.setPointerCapture(e.pointerId)
    void camera
    e.stopPropagation()
  }

  private startRotate(e: PointerEvent) {
    const pathId = this.store.ui.selection[0]
    if (!pathId) return
    const { sourceId } = parsePathId(pathId)
    const el = nodeElement(this.world, pathId)
    const node = this.store.doc.nodes[sourceId]
    if (!el || !node) return
    const rect = el.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const startAngle = (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI
    const base = node.style.rotate ? parseFloat(node.style.rotate) || 0 : 0
    this.gesture = { type: 'rotate', id: sourceId, el, centerX, centerY, startAngle, base }
    this.viewport.setPointerCapture(e.pointerId)
    e.stopPropagation()
  }

  private startDraw(e: PointerEvent, tool: Tool) {
    const world = this.toWorld(e)
    // Shapes land in the deepest container under the cursor; artboards land
    // on the page. Auto-layout containers receive flow children at an index.
    let container: DrawContainer = { parent: null, originX: 0, originY: 0, flex: false, index: 0 }
    if (tool !== 'frame') {
      const target = this.dropInfoAt(e, [])
      if (target && target.kind !== 'page') {
        container = {
          parent: target.id,
          originX: target.rect.x,
          originY: target.rect.y,
          flex: target.kind === 'flex',
          index: target.index,
        }
      }
    }
    this.gesture = { type: 'draw', tool, startWorldX: world.x, startWorldY: world.y, container }
    this.viewport.setPointerCapture(e.pointerId)
  }

  private finishDraw(g: Extract<Gesture, { type: 'draw' }>, e: PointerEvent) {
    const world = this.toWorld(e)
    let rect: Rect = {
      x: Math.min(g.startWorldX, world.x), y: Math.min(g.startWorldY, world.y),
      width: Math.abs(world.x - g.startWorldX), height: Math.abs(world.y - g.startWorldY),
    }
    if (e.shiftKey) {
      const side = Math.max(rect.width, rect.height)
      rect = { ...rect, width: side, height: side }
    }
    const isClick = rect.width < 4 && rect.height < 4
    if (isClick) {
      const defaults: Partial<Record<Tool, { w: number; h: number }>> = {
        frame: { w: 375, h: 667 }, rect: { w: 100, h: 100 }, ellipse: { w: 100, h: 100 },
        polygon: { w: 100, h: 100 }, star: { w: 100, h: 100 }, line: { w: 100, h: 0 },
      }
      const d = defaults[g.tool] ?? { w: 100, h: 100 }
      rect = { x: rect.x, y: rect.y, width: d.w, height: d.h }
    }

    const inPage = g.container.parent === null || g.tool === 'frame'
    const local: Rect = inPage
      ? rect
      : { ...rect, x: rect.x - g.container.originX, y: rect.y - g.container.originY }

    let node: NodeModel
    switch (g.tool) {
      case 'frame':
        node = createArtboard(this.nextArtboardName(), local)
        break
      case 'rect': node = createRectangle(local); break
      case 'ellipse': node = createEllipse(local); break
      case 'polygon': node = createPolygon(local); break
      case 'star': node = createStar(local); break
      case 'line': {
        const dx = world.x - g.startWorldX
        const dy = world.y - g.startWorldY
        const length = isClick ? 100 : Math.hypot(dx, dy)
        const angle = isClick ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI
        node = createLine(
          g.startWorldX - (inPage ? 0 : g.container.originX),
          g.startWorldY - (inPage ? 0 : g.container.originY),
          length, angle,
        )
        break
      }
      case 'text':
        node = createText(local.x, local.y)
        break
      default:
        return
    }

    // Drawing into an auto-layout container creates a flow child at the
    // pointer's insertion index instead of an absolute box.
    if (!inPage && g.container.flex) {
      delete node.style.position
      delete node.style.left
      delete node.style.top
    }
    const page = this.store.activePage()
    const at = inPage
      ? ({ kind: 'page', pageId: page.id, index: page.children.length } as const)
      : ({
          kind: 'node', parent: g.container.parent as NodeId,
          index: g.container.flex
            ? g.container.index
            : this.store.doc.nodes[g.container.parent as NodeId]?.children.length ?? 0,
        } as const)
    this.store.apply(`Create ${node.name}`, [
      { t: 'insertTree', nodes: [node], rootId: node.id, at },
    ])
    this.store.setSelection([node.id])
    this.store.recordSelectionAfter()
    this.store.setTool('select')
    if (g.tool === 'text') this.store.setUi({ editingTextId: node.id })
  }

  // --- Wheel / zoom --------------------------------------------------------

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const v = this.viewport.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      cameraStore.zoomAt(e.clientX - v.left, e.clientY - v.top, cameraStore.camera.scale * factor)
    } else if (e.shiftKey) {
      cameraStore.panBy(-(e.deltaY + e.deltaX), 0)
    } else {
      cameraStore.panBy(-e.deltaX, -e.deltaY)
    }
  }

  // --- Keyboard ------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement
    const inField =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    const { store } = this
    const mod = e.metaKey || e.ctrlKey

    if (e.code === 'Space' && !inField) {
      if (!this.spaceDown) {
        this.spaceDown = true
        if (this.gesture.type === 'idle') this.setCursor('grab')
      }
      e.preventDefault()
      return
    }

    if (mod && e.key.toLowerCase() === 'z') {
      // Undo/redo work even while a field is focused, like native apps.
      if (inField && !target.closest('[data-canvas-text]')) return
      e.preventDefault()
      if (e.shiftKey) store.redo()
      else store.undo()
      return
    }

    if (inField) return

    const sel = store.ui.selection
    const ctx = { store, getRect: (pathId: string) => this.rectOf(pathId) }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (sel.length > 0) {
          deleteNodes(ctx, sel.map((s) => parsePathId(s).sourceId))
          e.preventDefault()
        }
        return
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (sel.length === 0) return
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        nudgeNodes(ctx, sel.map((s) => parsePathId(s).sourceId), dx, dy)
        e.preventDefault()
        return
      }
      case 'Escape':
        if (store.ui.editingTextId) this.commitTextEdit()
        else if (sel.length > 0) store.setSelection([])
        else store.setTool('select')
        return
      case 'Enter':
        if (sel.length === 1) {
          const node = store.doc.nodes[sel[0]]
          if (node && !isSvgNode(node) && (node.text !== undefined || node.children.length === 0)) {
            store.setUi({ editingTextId: sel[0] })
            e.preventDefault()
          }
        }
        return
    }

    if (mod) {
      switch (e.key.toLowerCase()) {
        case 'd':
          e.preventDefault()
          if (sel.length > 0) {
            const ids = duplicateNodes(ctx, sel.map((s) => parsePathId(s).sourceId))
            store.setSelection(ids)
            store.recordSelectionAfter()
          }
          return
        case 'g':
          e.preventDefault()
          if (e.shiftKey) ungroupNodes(ctx, sel)
          else groupNodes(ctx, sel)
          return
        case 'a':
          e.preventDefault()
          store.setSelection([...store.activePage().children])
          return
        case 'c':
          if (sel.length > 0) {
            e.preventDefault()
            setClipboard(copyNodes(ctx, sel.map((s) => parsePathId(s).sourceId)))
          }
          return
        case 'x':
          if (sel.length > 0) {
            e.preventDefault()
            setClipboard(copyNodes(ctx, sel.map((s) => parsePathId(s).sourceId)))
            deleteNodes(ctx, sel.map((s) => parsePathId(s).sourceId))
          }
          return
        case 'v':
          if (clipboard.html) {
            e.preventDefault()
            pasteHtml(ctx, clipboard.html)
          }
          return
        case ']':
          e.preventDefault()
          reorderNodes(ctx, sel, e.altKey ? 'front' : 'forward')
          return
        case '[':
          e.preventDefault()
          reorderNodes(ctx, sel, e.altKey ? 'back' : 'backward')
          return
        case '0':
          e.preventDefault()
          this.zoomTo(1)
          return
        case '1':
          e.preventDefault()
          this.zoomToFit()
          return
        case '2':
          e.preventDefault()
          this.zoomToSelection()
          return
        case '=':
          e.preventDefault()
          this.zoomTo(cameraStore.camera.scale * 1.25)
          return
        case '-':
          e.preventDefault()
          this.zoomTo(cameraStore.camera.scale / 1.25)
          return
      }
      return
    }

    const toolKeys: Record<string, Tool> = {
      v: 'select', h: 'hand', f: 'frame', t: 'text', r: 'rect',
      o: 'ellipse', l: 'line', p: 'polygon', s: 'star', c: 'comment',
    }
    const tool = toolKeys[e.key.toLowerCase()]
    if (tool) {
      store.setTool(tool)
      this.setCursor(tool === 'hand' ? 'grab' : SHAPE_TOOLS.has(tool) ? 'crosshair' : '')
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') {
      this.spaceDown = false
      if (this.gesture.type === 'idle') this.setCursor(this.store.ui.tool === 'hand' ? 'grab' : '')
    }
  }

  private onDoubleClick(e: MouseEvent) {
    if (e.target instanceof Element && e.target.closest('[data-cz-ui],[data-handle]')) return
    const pathId = this.pickPathId(e)
    if (!pathId) return
    // Deep select: double-click jumps straight to the node under the cursor.
    // Double-clicking it again starts text editing on leaves.
    if (this.store.ui.selection.includes(pathId)) {
      const { sourceId, instanceId } = parsePathId(pathId)
      const node = this.store.doc.nodes[sourceId]
      if (!instanceId && node && node.children.length === 0 && !node.isArtboard && !isSvgNode(node)) {
        this.store.setUi({ editingTextId: pathId })
      }
      return
    }
    this.store.setSelection([pathId])
  }

  // --- Helpers -------------------------------------------------------------

  private nextArtboardName(): string {
    const page = this.store.activePage()
    const count = page.children.filter((id) => this.store.doc.nodes[id]?.isArtboard).length
    return `Frame ${count + 1}`
  }

  private commitTextEdit() {
    // NodeView owns commit-on-blur; here we only exit the mode.
    this.store.setUi({ editingTextId: null })
  }

  private setCursor(cursor: string) {
    this.viewport.style.cursor = cursor
  }

  private toWorld(e: { clientX: number; clientY: number }) {
    const v = this.viewport.getBoundingClientRect()
    return cameraStore.screenToWorld(e.clientX - v.left, e.clientY - v.top)
  }

  rectOf(pathId: string): Rect | null {
    const el = nodeElement(this.world, pathId)
    return el ? worldRectOf(el, this.viewport, cameraStore.camera) : null
  }

  private pickPathId(e: { clientX: number; clientY: number }): string | null {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!(el instanceof HTMLElement)) continue
      if (el.closest('[data-cz-ui]')) return null
      const hit = el.closest<HTMLElement>('[data-node-id]')
      if (hit && this.world.contains(hit)) {
        const pathId = hit.dataset.nodeId
        if (!pathId) continue
        const { sourceId } = parsePathId(pathId)
        const node = this.store.doc.nodes[parsePathId(pathId).instanceId ?? sourceId]
        if (node?.locked) continue
        return pathId
      }
    }
    return null
  }

  /** Top-level object -> ... -> deepest under cursor, as selectable path ids. */
  private selectionChain(pathId: string): string[] {
    const { instanceId } = parsePathId(pathId)
    const anchor = instanceId ?? pathId
    const chain: string[] = []
    let cur: NodeId | null = anchor
    while (cur) {
      const node: NodeModel | undefined = this.store.doc.nodes[cur]
      if (!node) break
      if (!node.isArtboard) chain.unshift(cur)
      if (!node.parent || this.store.doc.nodes[node.parent]?.isArtboard) break
      cur = node.parent
    }
    if (instanceId && pathId !== instanceId) chain.push(pathId)
    const result = chain.length > 0 ? chain : [pathId]
    // Vectors select as a unit: a single click stops at the svg root
    // (double-click still deep-selects paths inside).
    const svgIdx = result.findIndex(
      (id) => this.store.doc.nodes[parsePathId(id).sourceId]?.tag === 'svg',
    )
    return svgIdx >= 0 ? result.slice(0, svgIdx + 1) : result
  }

  private pickSelection(e: PointerEvent): string | null {
    const pathId = this.pickPathId(e)
    if (!pathId) return null
    const chain = this.selectionChain(pathId)
    if (e.metaKey || e.ctrlKey) return chain[chain.length - 1]
    const selected = this.store.ui.selection
    const existing = chain.find((id) => selected.includes(id))
    return existing ?? this.aimTarget(chain)
  }

  /**
   * One-click aiming: the deepest frame/shape under the cursor. Text leaves
   * and instance internals are skipped — they take a double-click (and a
   * second double-click starts text editing).
   */
  private aimTarget(chain: string[]): string {
    for (let i = chain.length - 1; i >= 0; i--) {
      const { sourceId, instanceId } = parsePathId(chain[i])
      if (instanceId && instanceId !== chain[i]) continue
      const node = this.store.doc.nodes[sourceId]
      if (node && !isTextNode(node)) return chain[i]
    }
    return chain[0]
  }

  private updateHover(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest('[data-cz-ui]')) {
      if (this.store.ui.hoverId) this.store.setUi({ hoverId: null })
      return
    }
    const pathId = this.pickPathId(e)
    const hover = pathId ? this.pickHoverTarget(pathId, e) : null
    if (hover !== this.store.ui.hoverId) this.store.setUi({ hoverId: hover })
  }

  private pickHoverTarget(pathId: string, e: PointerEvent): string {
    if (e.metaKey || e.ctrlKey) return pathId
    const chain = this.selectionChain(pathId)
    const selected = this.store.ui.selection
    return chain.find((id) => selected.includes(id)) ?? this.aimTarget(chain)
  }

  /** Containers under the cursor that could receive dragged/drawn nodes. */
  private dropInfoAt(e: { clientX: number; clientY: number }, excluded: NodeId[]): DropInfo {
    const excludedSet = new Set(excluded)
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!(el instanceof HTMLElement)) continue
      if (el.closest('[data-cz-ui]')) continue
      const hit = el.closest<HTMLElement>('[data-node-id]')
      if (!hit || !this.world.contains(hit)) continue
      const pathId = hit.dataset.nodeId
      if (!pathId) continue
      const { sourceId, instanceId } = parsePathId(pathId)
      if (instanceId) continue // cannot drop into instances
      const node = this.store.doc.nodes[sourceId]
      if (!node || excludedSet.has(sourceId)) continue
      if (excluded.some((ex) => this.isDescendantOf(sourceId, ex))) continue
      if (!canReceiveChildren(node)) continue
      const rect = worldRectOf(hit, this.viewport, cameraStore.camera)
      const display = getComputedStyle(hit).display
      if (display === 'flex' || display === 'inline-flex') {
        const { index, guide } = this.flexInsertion(node, hit, rect, e, excludedSet)
        return { kind: 'flex', id: sourceId, rect, index, guide }
      }
      // Same absolute parent for everything dragged: plain move, no reparent.
      if (excluded.length > 0 && excluded.every((id) => this.store.doc.nodes[id]?.parent === sourceId)) {
        return null
      }
      return { kind: 'abs', id: sourceId, rect, index: node.children.length }
    }
    // Nothing under the cursor: dragging out to the page surface.
    if (excluded.length > 0 && excluded.some((id) => this.store.doc.nodes[id]?.parent !== null)) {
      return { kind: 'page', index: this.store.activePage().children.length }
    }
    return null
  }

  /**
   * Insertion point inside an auto-layout container: index among flow
   * children (pointer past their midpoints along the flex axis) plus a
   * world-space indicator line for the overlay.
   */
  private flexInsertion(
    container: NodeModel,
    containerEl: HTMLElement,
    containerRect: Rect,
    e: { clientX: number; clientY: number },
    excludedSet: ReadonlySet<NodeId>,
  ): { index: number; guide: SnapGuide } {
    const world = this.toWorld(e)
    const direction = getComputedStyle(containerEl).flexDirection
    const horizontal = direction.startsWith('row')
    const reversed = direction.endsWith('reverse')

    const flowRects: Rect[] = []
    const flowArrayPos: number[] = []
    let pos = 0
    for (const childId of container.children) {
      if (excludedSet.has(childId)) continue // removed before insert
      const childNode = this.store.doc.nodes[childId]
      const childEl = childNode ? nodeElement(this.world, childId) : null
      if (childNode && childEl && childNode.style.position !== 'absolute' && childNode.visible) {
        flowRects.push(worldRectOf(childEl, this.viewport, cameraStore.camera))
        flowArrayPos.push(pos)
      }
      pos++
    }

    let flowIndex = 0
    const pointer = horizontal ? world.x : world.y
    for (const r of flowRects) {
      const mid = horizontal ? r.x + r.width / 2 : r.y + r.height / 2
      if (reversed ? pointer < mid : pointer > mid) flowIndex++
    }
    const index =
      flowIndex < flowArrayPos.length ? flowArrayPos[flowIndex] : pos

    // Indicator line at the insertion gap.
    let linePos: number
    if (flowRects.length === 0) {
      linePos = horizontal ? containerRect.x + 4 : containerRect.y + 4
    } else if (flowIndex === 0) {
      const r = flowRects[0]
      linePos = (horizontal ? r.x : r.y) - 2
    } else if (flowIndex >= flowRects.length) {
      const r = flowRects[flowRects.length - 1]
      linePos = horizontal ? r.x + r.width + 2 : r.y + r.height + 2
    } else {
      const a = flowRects[flowIndex - 1]
      const b = flowRects[flowIndex]
      linePos = horizontal ? (a.x + a.width + b.x) / 2 : (a.y + a.height + b.y) / 2
    }
    const guide: SnapGuide = horizontal
      ? { axis: 'x', position: linePos, from: containerRect.y + 2, to: containerRect.y + containerRect.height - 2 }
      : { axis: 'y', position: linePos, from: containerRect.x + 2, to: containerRect.x + containerRect.width - 2 }
    return { index, guide }
  }

  private isDescendantOf(id: NodeId, maybeAncestor: NodeId): boolean {
    let cur = this.store.doc.nodes[id]?.parent ?? null
    while (cur) {
      if (cur === maybeAncestor) return true
      cur = this.store.doc.nodes[cur]?.parent ?? null
    }
    return false
  }

  private snapTargetsFor(excluded: NodeId[]): Rect[] {
    const targets: Rect[] = []
    const excludedSet = new Set(excluded)
    const page = this.store.activePage()
    for (const id of page.children) {
      if (excludedSet.has(id)) continue
      const el = nodeElement(this.world, id)
      if (!el) continue
      targets.push(worldRectOf(el, this.viewport, cameraStore.camera))
      // Include first-level children of artboards as snap candidates.
      const node = this.store.doc.nodes[id]
      if (node?.isArtboard) {
        for (const childId of node.children) {
          if (excludedSet.has(childId)) continue
          const childEl = nodeElement(this.world, childId)
          if (childEl) targets.push(worldRectOf(childEl, this.viewport, cameraStore.camera))
        }
      }
    }
    return targets.slice(0, 400)
  }

  private marqueeHits(worldRect: Rect): NodeId[] {
    const hits: NodeId[] = []
    const page = this.store.activePage()
    for (const id of page.children) {
      const node = this.store.doc.nodes[id]
      const el = nodeElement(this.world, id)
      if (!node || !el || node.locked || !node.visible) continue
      const rect = worldRectOf(el, this.viewport, cameraStore.camera)
      if (node.isArtboard) {
        if (rectContains(worldRect, rect)) {
          hits.push(id)
        } else if (rectsIntersect(worldRect, rect)) {
          for (const childId of node.children) {
            const child = this.store.doc.nodes[childId]
            const childEl = nodeElement(this.world, childId)
            if (!child || !childEl || child.locked || !child.visible) continue
            if (rectsIntersect(worldRect, worldRectOf(childEl, this.viewport, cameraStore.camera))) {
              hits.push(childId)
            }
          }
        }
      } else if (rectsIntersect(worldRect, rect)) {
        hits.push(id)
      }
    }
    return hits
  }

  // --- Zoom helpers --------------------------------------------------------

  zoomTo(scale: number) {
    const v = this.viewport.getBoundingClientRect()
    cameraStore.zoomAt(v.width / 2, v.height / 2, scale)
  }

  zoomToFit() {
    const page = this.store.activePage()
    const rects = page.children
      .map((id) => this.rectOf(id))
      .filter((r): r is Rect => r !== null)
    const union = unionRects(rects)
    if (!union) return
    const v = this.viewport.getBoundingClientRect()
    cameraStore.fitRect(union, { width: v.width, height: v.height })
  }

  zoomToSelection() {
    const rects = this.store.ui.selection
      .map((id) => this.rectOf(id))
      .filter((r): r is Rect => r !== null)
    const union = unionRects(rects)
    if (!union) return
    const v = this.viewport.getBoundingClientRect()
    cameraStore.fitRect(union, { width: v.width, height: v.height })
  }
}
