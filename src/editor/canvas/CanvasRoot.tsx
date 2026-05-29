import { useEffect, useRef, useSyncExternalStore } from 'react'
import { cameraStore } from './camera'
import { InteractionController } from './controller'
import { NodeView } from './NodeView'
import { createOverlay } from './overlay'
import { editorStore } from '../store/editorStore'

/**
 * The infinite canvas. World content is React-rendered DOM; camera transform,
 * selection overlay, and all gestures are imperative and never re-render
 * React. The overlay is a sibling of the world, so selection chrome cannot
 * reflow canvas content.
 */

/** Other UI (toolbar zoom menu, panels) reach the active controller here. */
export const controllerRef: { current: InteractionController | null } = { current: null }

export function CanvasRoot() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)

  const pageChildren = useSyncExternalStore(
    editorStore.subscribeDoc,
    () => editorStore.activePage().children,
    () => editorStore.activePage().children,
  )
  const tokens = useSyncExternalStore(
    editorStore.subscribeDoc,
    () => editorStore.doc.tokens,
    () => editorStore.doc.tokens,
  )

  useEffect(() => {
    const viewport = viewportRef.current
    const world = worldRef.current
    if (!viewport || !world) return

    const applyCamera = () => {
      const { x, y, scale } = cameraStore.camera
      world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
      if (editorStore.ui.showGrid) {
        const step = 8 * scale
        viewport.style.backgroundImage =
          step >= 4
            ? `radial-gradient(circle, var(--cz-grid-dot) 1px, transparent 1px)`
            : 'none'
        viewport.style.backgroundSize = `${step}px ${step}px`
        viewport.style.backgroundPosition = `${x}px ${y}px`
      } else {
        viewport.style.backgroundImage = 'none'
      }
    }
    applyCamera()
    const unsubCamera = cameraStore.subscribe(applyCamera)
    const unsubUi = editorStore.subscribeUi(applyCamera)

    const controller = new InteractionController(viewport, world, editorStore, overlayProxy)
    const overlay = createOverlay({
      viewport, world, store: editorStore,
      onArtboardLabelPointerDown: controller.artboardLabelPointerDown,
    })
    // The controller was constructed before the overlay existed; wire it now.
    overlayProxy.target = overlay
    controllerRef.current = controller

    return () => {
      controllerRef.current = null
      controller.destroy()
      overlay.destroy()
      overlayProxy.target = null
      unsubCamera()
      unsubUi()
    }
  }, [])

  const { x, y, scale } = cameraStore.camera
  return (
    <div
      ref={viewportRef}
      data-canvas
      className="relative h-full w-full overflow-hidden bg-[var(--cz-canvas-bg)]"
    >
      <div
        ref={worldRef}
        data-canvas-world
        className="absolute left-0 top-0 h-0 w-0"
        style={{
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
          transformOrigin: '0 0',
          ...Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k.startsWith('--') ? k : `--${k}`, v])),
        }}
      >
        {pageChildren.map((id) => (
          <NodeView key={id} id={id} />
        ))}
      </div>
    </div>
  )
}

/**
 * Overlay and controller depend on each other (controller drives marquee and
 * guides; overlay labels start drags). A tiny forwarding proxy breaks the
 * construction cycle.
 */
const overlayProxy: {
  target: ReturnType<typeof createOverlay> | null
} & ReturnType<typeof createOverlay> = {
  target: null,
  refresh: () => overlayProxy.target?.refresh(),
  setMarquee: (r) => overlayProxy.target?.setMarquee(r),
  setGuides: (g) => overlayProxy.target?.setGuides(g),
  setSizeBadge: (p, l) => overlayProxy.target?.setSizeBadge(p, l),
  setHidden: (h) => overlayProxy.target?.setHidden(h),
  destroy: () => overlayProxy.target?.destroy(),
}
