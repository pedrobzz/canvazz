import type { DocumentModel } from '../model/types'

/**
 * Asset reference resolution. `import_asset` stores image bytes once in
 * doc.assets and nodes reference them by the short, stable handle
 * `asset://<assetId>` (in an <img src> or inside a CSS url(...)). Resolution is
 * deferred to render/export time:
 *   - the canvas (NodeView) and screenshots swap the handle for the data URL,
 *   - export resolves to the data URL too, deduped behind CSS custom props.
 * Docs predating this scheme inline data: URLs directly; those pass through
 * untouched, so old documents render and export exactly as before.
 */

/** The handle scheme nodes store instead of an inlined data URL. */
export const ASSET_SCHEME = 'asset://'

const ASSET_ID_RE = /^[A-Za-z0-9_-]+$/

/** A bare `asset://<id>` reference -> its asset id, or null if not one. */
export function assetIdFromRef(ref: string): string | null {
  if (!ref.startsWith(ASSET_SCHEME)) return null
  const id = ref.slice(ASSET_SCHEME.length)
  return ASSET_ID_RE.test(id) ? id : null
}

/** The data URL (or app URL) backing `asset://<id>`, or null when unknown. */
export function resolveAssetRef(doc: DocumentModel, ref: string): string | null {
  const id = assetIdFromRef(ref)
  if (id === null) return null
  return doc.assets?.[id]?.url ?? null
}

/**
 * Resolve any `asset://<id>` substrings inside a CSS url(...) value to their
 * backing URLs. Leaves non-asset urls and unknown handles untouched, so this
 * is safe to run over every style value. Used at render time, where each
 * url() must carry the real bytes (no shared custom-prop layer).
 */
export function resolveAssetUrlsInline(doc: DocumentModel, value: string): string {
  if (!value.includes(ASSET_SCHEME)) return value
  return value.replace(URL_REF_RE, (whole, quote: string, ref: string) => {
    const resolved = resolveAssetRef(doc, ref)
    return resolved === null ? whole : `url(${quote}${resolved}${quote})`
  })
}

// url( "asset://x" ) / url('asset://x') / url(asset://x) — capture the optional
// quote so we can re-emit the value with the same quoting style.
const URL_REF_RE = /url\(\s*(["']?)(asset:\/\/[A-Za-z0-9_-]+)\1\s*\)/g

/** Resolve the `src` of an <img>: a bare handle becomes its data URL. */
export function resolveImgSrc(doc: DocumentModel, src: string): string {
  return resolveAssetRef(doc, src) ?? src
}

/**
 * Every asset id referenced anywhere in a value (img src or css url()), in
 * first-seen order. Export uses this to define each used asset once.
 */
export function assetIdsInValue(value: string): string[] {
  const out: string[] = []
  const push = (id: string) => {
    if (!out.includes(id)) out.push(id)
  }
  const direct = assetIdFromRef(value.trim())
  if (direct !== null) push(direct)
  for (const m of value.matchAll(URL_REF_RE)) {
    const id = assetIdFromRef(m[2])
    if (id !== null) push(id)
  }
  return out
}
