/**
 * Camera (pan/zoom) lives outside React. Subscribers (the world transform,
 * the selection overlay, rulers) apply it directly to the DOM, so panning and
 * zooming never trigger React renders.
 */

export interface Camera {
  x: number
  y: number
  scale: number
}

export const MIN_SCALE = 0.02
export const MAX_SCALE = 64

type Listener = (camera: Camera) => void

export class CameraStore {
  camera: Camera = { x: 0, y: 0, scale: 1 }
  private listeners = new Set<Listener>()

  subscribe(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  set(next: Partial<Camera>) {
    const scale = clamp(next.scale ?? this.camera.scale, MIN_SCALE, MAX_SCALE)
    this.camera = { x: next.x ?? this.camera.x, y: next.y ?? this.camera.y, scale }
    for (const fn of this.listeners) fn(this.camera)
  }

  panBy(dx: number, dy: number) {
    this.set({ x: this.camera.x + dx, y: this.camera.y + dy })
  }

  /** Zoom keeping the given screen point (viewport-relative px) fixed. */
  zoomAt(screenX: number, screenY: number, nextScale: number) {
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
    const { x, y, scale: prev } = this.camera
    const worldX = (screenX - x) / prev
    const worldY = (screenY - y) / prev
    this.set({ scale, x: screenX - worldX * scale, y: screenY - worldY * scale })
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const { x, y, scale } = this.camera
    return { x: (screenX - x) / scale, y: (screenY - y) / scale }
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const { x, y, scale } = this.camera
    return { x: worldX * scale + x, y: worldY * scale + y }
  }

  /** Fit a world-space rect into the viewport with padding. */
  fitRect(
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
    padding = 64,
  ) {
    if (rect.width <= 0 || rect.height <= 0) return
    const scale = clamp(
      Math.min(
        (viewport.width - padding * 2) / rect.width,
        (viewport.height - padding * 2) / rect.height,
      ),
      MIN_SCALE,
      MAX_SCALE,
    )
    this.set({
      scale,
      x: viewport.width / 2 - (rect.x + rect.width / 2) * scale,
      y: viewport.height / 2 - (rect.y + rect.height / 2) * scale,
    })
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export const cameraStore = new CameraStore()
