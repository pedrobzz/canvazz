import { cameraStore } from './camera'
import { nodeElement, screenRectOf, worldToScreenRect } from './geometry'
import { parsePathId } from '../model/instances'
import type { Rect, SnapGuide } from './geometry'
import type { EditorStore } from '../store/editorStore'

/**
 * Selection overlay: a screen-space layer that never reflows canvas content.
 * It is fully imperative — pooled DOM elements positioned from DOMRects — so
 * hover/drag/zoom updates cost zero React renders. The canvas DOM stays
 * untouched (no outline/border mutations on content elements).
 */

export interface Overlay {
  refresh(): void
  setMarquee(rect: Rect | null): void
  setGuides(guides: SnapGuide[]): void
  setSizeBadge(screenPos: { x: number; y: number } | null, label?: string): void
  setHidden(hidden: boolean): void
  destroy(): void
}

export const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type HandleDir = (typeof HANDLE_DIRS)[number]

const HANDLE_CURSORS: Record<HandleDir, string> = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
  se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  parent.appendChild(el)
  return el
}

interface OverlayDeps {
  viewport: HTMLElement
  world: HTMLElement
  store: EditorStore
  onArtboardLabelPointerDown?: (id: string, e: PointerEvent) => void
}

export function createOverlay({ viewport, world, store, onArtboardLabelPointerDown }: OverlayDeps): Overlay {
  const root = div('cz-overlay', viewport)

  const hoverBox = div('cz-hover-box', root)
  const selectionBox = div('cz-selection-box', root)
  const handles: Record<HandleDir, HTMLDivElement> = {} as Record<HandleDir, HTMLDivElement>
  for (const dir of HANDLE_DIRS) {
    const h = div(`cz-handle cz-handle-${dir}`, selectionBox)
    h.dataset.handle = dir
    h.style.cursor = HANDLE_CURSORS[dir]
    handles[dir] = h
  }
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    const r = div(`cz-rotate-zone cz-rotate-${corner}`, selectionBox)
    r.dataset.handle = 'rotate'
  }
  const marqueeEl = div('cz-marquee', root)
  const sizeBadge = div('cz-size-badge', root)
  const outlinePool: HTMLDivElement[] = []
  const guidePool: HTMLDivElement[] = []
  const labelPool: HTMLDivElement[] = []
  const aiPool: HTMLDivElement[] = []

  let raf = 0
  let hidden = false

  const scheduleRefresh = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      refresh()
    })
  }

  function place(el: HTMLElement, rect: Rect) {
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    el.style.display = 'block'
  }

  function poolGet(pool: HTMLDivElement[], i: number, className: string): HTMLDivElement {
    while (pool.length <= i) pool.push(div(className, root))
    return pool[i]
  }

  function poolTrim(pool: HTMLDivElement[], used: number) {
    for (let i = used; i < pool.length; i++) pool[i].style.display = 'none'
  }

  function refresh() {
    const camera = cameraStore.camera
    const { selection, hoverId, editingTextId, aiChanged } = store.ui

    // Hover outline
    if (hoverId && !hidden && !selection.includes(hoverId)) {
      const el = nodeElement(world, hoverId)
      if (el) place(hoverBox, screenRectOf(el, viewport))
      else hoverBox.style.display = 'none'
    } else {
      hoverBox.style.display = 'none'
    }

    // Selection box + handles
    const els = selection
      .map((pathId) => ({ pathId, el: nodeElement(world, pathId) }))
      .filter((x): x is { pathId: string; el: HTMLElement } => x.el !== null)

    if (els.length === 0 || hidden) {
      selectionBox.style.display = 'none'
      poolTrim(outlinePool, 0)
    } else if (els.length === 1) {
      const { pathId, el } = els[0]
      const rect = screenRectOf(el, viewport)
      const { sourceId } = parsePathId(pathId)
      const node = store.doc.nodes[sourceId]
      const rotation = node?.style.rotate ? parseFloat(node.style.rotate) || 0 : 0
      if (rotation !== 0 && el instanceof HTMLElement) {
        // AABB center == rotated box center (rotation about center).
        const w = el.offsetWidth * camera.scale
        const h = el.offsetHeight * camera.scale
        const cx = rect.x + rect.width / 2
        const cy = rect.y + rect.height / 2
        selectionBox.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px) rotate(${rotation}deg)`
        selectionBox.style.width = `${w}px`
        selectionBox.style.height = `${h}px`
        selectionBox.style.display = 'block'
      } else {
        place(selectionBox, rect)
        selectionBox.style.transform += ''
      }
      selectionBox.classList.toggle('cz-selection-editing', editingTextId === pathId)
      poolTrim(outlinePool, 0)
    } else {
      const rects = els.map(({ el }) => screenRectOf(el, viewport))
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      rects.forEach((r) => {
        x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y)
        x2 = Math.max(x2, r.x + r.width); y2 = Math.max(y2, r.y + r.height)
      })
      place(selectionBox, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 })
      selectionBox.classList.remove('cz-selection-editing')
      const shown = Math.min(rects.length, 24)
      for (let i = 0; i < shown; i++) place(poolGet(outlinePool, i, 'cz-outline'), rects[i])
      poolTrim(outlinePool, shown)
    }

    // AI change indicators (pulse) on recently AI-touched nodes.
    let aiCount = 0
    if (!hidden && aiChanged.length > 0) {
      for (const id of aiChanged.slice(0, 16)) {
        const el = nodeElement(world, id)
        if (!el) continue
        place(poolGet(aiPool, aiCount, 'cz-ai-outline'), screenRectOf(el, viewport))
        aiCount++
      }
    }
    poolTrim(aiPool, aiCount)

    // Artboard name labels
    const page = store.activePage()
    let labelCount = 0
    for (const id of page.children) {
      const node = store.doc.nodes[id]
      if (!node?.isArtboard) continue
      const el = nodeElement(world, id)
      if (!el) continue
      const rect = screenRectOf(el, viewport)
      if (rect.x + rect.width < -200 || rect.y + rect.height < -200) continue
      const label = poolGet(labelPool, labelCount, 'cz-artboard-label')
      label.textContent = node.name
      label.style.transform = `translate(${rect.x}px, ${rect.y - 22}px)`
      label.style.display = 'block'
      label.style.maxWidth = `${Math.max(60, rect.width)}px`
      label.classList.toggle('cz-artboard-label-selected', selection.includes(id))
      if (label.dataset.artboardId !== id) {
        label.dataset.artboardId = id
        label.onpointerdown = (e) => {
          e.stopPropagation()
          onArtboardLabelPointerDown?.(id, e)
        }
      }
      labelCount++
    }
    poolTrim(labelPool, labelCount)
  }

  const unsubs = [
    cameraStore.subscribe(scheduleRefresh),
    store.subscribeDoc(scheduleRefresh),
    store.subscribeUi(scheduleRefresh),
  ]
  const resizeObserver = new ResizeObserver(scheduleRefresh)
  resizeObserver.observe(viewport)
  // Content size changes (text edits, image loads, flex reflow) move things
  // without doc changes from our side; observe subtree box mutations cheaply.
  const mutationObserver = new MutationObserver(scheduleRefresh)
  mutationObserver.observe(world, { attributes: true, childList: true, subtree: true, characterData: true })

  refresh()

  return {
    refresh,
    setMarquee(rect) {
      if (rect) place(marqueeEl, rect)
      else marqueeEl.style.display = 'none'
    },
    setGuides(guides) {
      const camera = cameraStore.camera
      for (let i = 0; i < guides.length && i < 8; i++) {
        const g = guides[i]
        const el = poolGet(guidePool, i, 'cz-snap-guide')
        if (g.axis === 'x') {
          const screen = worldToScreenRect({ x: g.position, y: g.from, width: 0, height: g.to - g.from }, camera)
          place(el, { x: screen.x, y: screen.y, width: 1, height: screen.height })
        } else {
          const screen = worldToScreenRect({ x: g.from, y: g.position, width: g.to - g.from, height: 0 }, camera)
          place(el, { x: screen.x, y: screen.y, width: screen.width, height: 1 })
        }
      }
      poolTrim(guidePool, Math.min(guides.length, 8))
    },
    setSizeBadge(screenPos, label = '') {
      if (!screenPos) {
        sizeBadge.style.display = 'none'
        return
      }
      sizeBadge.textContent = label
      sizeBadge.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px) translateX(-50%)`
      sizeBadge.style.display = 'block'
    },
    setHidden(value) {
      hidden = value
      scheduleRefresh()
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf)
      unsubs.forEach((u) => u())
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      root.remove()
    },
  }
}
