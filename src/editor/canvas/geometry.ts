import type { Camera } from './camera'
import type { DocumentModel, NodeId } from '../model/types'

/**
 * Geometry is always derived from the live DOM (DOMRect + computed styles),
 * never duplicated in the model. The browser is the layout engine.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const rectCenter = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export const rectContains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.width)
    y2 = Math.max(y2, r.y + r.height)
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/** Screen-space rect (viewport-relative CSS px) of an element. */
export function screenRectOf(el: Element, viewport: HTMLElement): Rect {
  const r = el.getBoundingClientRect()
  const v = viewport.getBoundingClientRect()
  return { x: r.left - v.left, y: r.top - v.top, width: r.width, height: r.height }
}

export function screenToWorldRect(rect: Rect, camera: Camera): Rect {
  return {
    x: (rect.x - camera.x) / camera.scale,
    y: (rect.y - camera.y) / camera.scale,
    width: rect.width / camera.scale,
    height: rect.height / camera.scale,
  }
}

export function worldToScreenRect(rect: Rect, camera: Camera): Rect {
  return {
    x: rect.x * camera.scale + camera.x,
    y: rect.y * camera.scale + camera.y,
    width: rect.width * camera.scale,
    height: rect.height * camera.scale,
  }
}

/** World-space AABB of a node's element. */
export function worldRectOf(el: Element, viewport: HTMLElement, camera: Camera): Rect {
  return screenToWorldRect(screenRectOf(el, viewport), camera)
}

export function nodeElement(world: HTMLElement, pathId: string): HTMLElement | null {
  return world.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(pathId)}"]`)
}

/** Rotation in degrees from the model (CSS `rotate` property). */
export function nodeRotation(doc: DocumentModel, id: NodeId): number {
  const raw = doc.nodes[id]?.style.rotate
  if (!raw) return 0
  const m = /^(-?[\d.]+)deg$/.exec(raw.trim())
  return m ? parseFloat(m[1]) : 0
}

/** Parse "123px" -> 123; returns null for anything else. */
export function px(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(-?[\d.]+)px$/.exec(value.trim())
  return m ? parseFloat(m[1]) : null
}

export const fmtPx = (n: number) => `${Math.round(n * 100) / 100}px`

/**
 * Snap a moving rect's edges/centers against target edges/centers.
 * Returns adjusted deltas and the guide lines to draw (world coords).
 */
export interface SnapGuide {
  axis: 'x' | 'y'
  position: number
  from: number
  to: number
}

export function snapRect(
  moving: Rect,
  targets: Rect[],
  threshold: number,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const movingXs = [moving.x, moving.x + moving.width / 2, moving.x + moving.width]
  const movingYs = [moving.y, moving.y + moving.height / 2, moving.y + moving.height]
  let bestDx: number | null = null
  let bestDy: number | null = null
  let guideX: SnapGuide | null = null
  let guideY: SnapGuide | null = null

  for (const t of targets) {
    const targetXs = [t.x, t.x + t.width / 2, t.x + t.width]
    const targetYs = [t.y, t.y + t.height / 2, t.y + t.height]
    for (const mx of movingXs) {
      for (const tx of targetXs) {
        const d = tx - mx
        if (Math.abs(d) <= threshold && (bestDx === null || Math.abs(d) < Math.abs(bestDx))) {
          bestDx = d
          guideX = {
            axis: 'x', position: tx,
            from: Math.min(moving.y, t.y),
            to: Math.max(moving.y + moving.height, t.y + t.height),
          }
        }
      }
    }
    for (const my of movingYs) {
      for (const ty of targetYs) {
        const d = ty - my
        if (Math.abs(d) <= threshold && (bestDy === null || Math.abs(d) < Math.abs(bestDy))) {
          bestDy = d
          guideY = {
            axis: 'y', position: ty,
            from: Math.min(moving.x, t.x),
            to: Math.max(moving.x + moving.width, t.x + t.width),
          }
        }
      }
    }
  }

  const guides: SnapGuide[] = []
  if (guideX) guides.push(guideX)
  if (guideY) guides.push(guideY)
  return { dx: bestDx ?? 0, dy: bestDy ?? 0, guides }
}
