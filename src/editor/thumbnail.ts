import { toJpeg } from 'html-to-image'
import { saveThumbnail } from '#/server/projectFns'
import type { EditorStore } from './store/editorStore'

/**
 * Project thumbnails for the Files page: a small JPEG of the first artboard,
 * captured from the live canvas after edits settle and stored on the project
 * row. Capturing on save (debounced, in idle time) keeps the Files index
 * instant — it renders plain <img>s instead of loading whole documents.
 */

const THUMB_WIDTH = 480
const SETTLE_MS = 4000

async function capture(store: EditorStore): Promise<string | null> {
  const page = store.activePage()
  const artboardId = page.children.find((id) => store.doc.nodes[id]?.isArtboard)
  if (!artboardId) return null
  const el = document
    .querySelector('[data-canvas-world]')
    ?.querySelector<HTMLElement>(`[data-node-id="${artboardId}"]`)
  if (!el) return null
  const scale = Math.min(1, THUMB_WIDTH / Math.max(el.offsetWidth, 1))
  // Same capture quirks as get_screenshot: neutralize canvas placement so the
  // clone sits at the viewport origin; downscale via canvas size (pixelRatio
  // < 1 renders blank in html-to-image).
  return toJpeg(el, {
    quality: 0.75,
    pixelRatio: 1,
    canvasWidth: Math.round(el.offsetWidth * scale),
    canvasHeight: Math.round(el.offsetHeight * scale),
    skipFonts: true,
    backgroundColor: '#ffffff',
    style: { transform: 'none', rotate: 'none', position: 'static', left: '0px', top: '0px', margin: '0' },
  })
}

/** Capture after edits (debounced) plus once after load settles. */
export function startThumbnailCapture(store: EditorStore, projectId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let busy = false

  const run = () => {
    timer = null
    if (stopped || busy) return
    busy = true
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 200))
    idle(() => {
      void capture(store)
        .then((dataUrl) => {
          if (dataUrl && !stopped) return saveThumbnail({ data: { id: projectId, dataUrl } })
        })
        .catch((err) => console.warn('Thumbnail capture failed:', err))
        .finally(() => {
          busy = false
        })
    })
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, SETTLE_MS)
  }

  schedule() // covers projects that predate thumbnails or were just imported
  const unsub = store.subscribeDoc(schedule)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    unsub()
  }
}
