import { describe, expect, it } from 'vitest'
import { aiToolExecutors } from '#/editor/ai/aiTools'
import { editorStore } from '#/editor/store/editorStore'
import { emptyDocument } from '#/editor/model/doc'

const PNG = 'data:image/png;base64,AAAA' // 4 base64 chars -> 3 bytes

async function importAsset(args: Record<string, unknown>) {
  editorStore.replaceDocument(emptyDocument('d', 'T'))
  return (await aiToolExecutors.import_asset(args)) as Record<string, unknown>
}

describe('import_asset executor (#12)', () => {
  it('returns a stable asset:// handle, not the data URL', async () => {
    const res = await importAsset({ dataUrl: PNG, name: 'logo' })
    expect(res.ok).toBe(true)
    expect(res.url).toBe(`asset://${res.assetId}`)
    expect(res.mime).toBe('image/png')
    expect(res.bytes).toBe(3)
    expect(res.name).toBe('logo')
    // The echoed url is the short handle, never the base64 blob.
    expect(String(res.url)).not.toContain('base64')
    expect(String(res.hint)).toContain(`<img src="asset://${res.assetId}">`)
  })

  it('stores the bytes once in doc.assets under the returned id', async () => {
    const res = await importAsset({ dataUrl: PNG })
    const asset = editorStore.doc.assets[res.assetId as string]
    expect(asset?.url).toBe(PNG)
    expect(asset?.mime).toBe('image/png')
  })

  it('accepts base64 + mime as an alternative to a data URL', async () => {
    const res = await importAsset({ base64: 'AAAA', mime: 'image/jpeg', name: 'photo' })
    expect(res.mime).toBe('image/jpeg')
    const asset = editorStore.doc.assets[res.assetId as string]
    expect(asset?.url).toBe('data:image/jpeg;base64,AAAA')
  })

  it('defaults the name from the mime when none is given', async () => {
    const res = await importAsset({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
    expect(res.name).toBe('asset.svg+xml')
  })

  it('rejects input that is neither a data URL nor base64 + mime', async () => {
    await expect(importAsset({ name: 'x' })).rejects.toThrow(/data: URL/)
    await expect(importAsset({ dataUrl: 'not-a-data-url' })).rejects.toThrow(/data: URL/)
  })
})
