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
