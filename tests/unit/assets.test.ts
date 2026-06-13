import { describe, expect, it } from 'vitest'
import {
  assetIdFromRef, assetIdsInValue, resolveAssetRef, resolveAssetUrlsInline, resolveImgSrc,
} from '#/editor/compiler/assets'
import { emptyDocument } from '#/editor/model/doc'
import { exportHtml, exportJsx } from '#/editor/compiler/export'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

const DATA_A = 'data:image/png;base64,AAAA'
const DATA_B = 'data:image/png;base64,BBBB'

function node(p: Partial<NodeModel> & Pick<NodeModel, 'id' | 'tag'>): NodeModel {
  return {
    name: p.id, attrs: {}, style: {}, classes: [], children: [],
    parent: null, visible: true, locked: false, ...p,
  } as NodeModel
}

function docWithAssets(): DocumentModel {
  const doc = emptyDocument('d', 'T')
  doc.assets = {
    a1: { id: 'a1', name: 'logo', mime: 'image/png', size: 4, url: DATA_A },
    a2: { id: 'a2', name: 'bg', mime: 'image/png', size: 4, url: DATA_B },
  }
  return doc
}

describe('asset handle helpers', () => {
  it('parses asset:// refs and rejects malformed/non-asset ones', () => {
    expect(assetIdFromRef('asset://a1')).toBe('a1')
    expect(assetIdFromRef('asset://A_b-2')).toBe('A_b-2')
    expect(assetIdFromRef('https://x/a.png')).toBeNull()
    expect(assetIdFromRef('asset://a/../b')).toBeNull()
    expect(assetIdFromRef('asset://')).toBeNull()
  })

  it('resolves a handle to its stored url, unknown ids to null', () => {
    const doc = docWithAssets()
    expect(resolveAssetRef(doc, 'asset://a1')).toBe(DATA_A)
    expect(resolveAssetRef(doc, 'asset://missing')).toBeNull()
    expect(resolveAssetRef(doc, 'data:image/png;base64,ZZ')).toBeNull()
  })

  it('resolveImgSrc swaps a handle for its url, leaves real urls untouched', () => {
    const doc = docWithAssets()
    expect(resolveImgSrc(doc, 'asset://a1')).toBe(DATA_A)
    expect(resolveImgSrc(doc, 'https://x/a.png')).toBe('https://x/a.png')
    expect(resolveImgSrc(doc, 'asset://missing')).toBe('asset://missing')
  })

  it('resolveAssetUrlsInline rewrites url(asset://) keeping the quote style', () => {
    const doc = docWithAssets()
    expect(resolveAssetUrlsInline(doc, 'url(asset://a1)')).toBe(`url(${DATA_A})`)
    expect(resolveAssetUrlsInline(doc, 'url("asset://a2")')).toBe(`url("${DATA_B}")`)
    expect(resolveAssetUrlsInline(doc, 'url(https://x/a.png)')).toBe('url(https://x/a.png)')
    // Unknown handle is left as-is rather than blanked.
    expect(resolveAssetUrlsInline(doc, 'url(asset://zzz)')).toBe('url(asset://zzz)')
  })

  it('assetIdsInValue lists each referenced id once, in order', () => {
    expect(assetIdsInValue('asset://a1')).toEqual(['a1'])
    expect(assetIdsInValue('url(asset://a2), url("asset://a1"), url(asset://a2)')).toEqual(['a2', 'a1'])
    expect(assetIdsInValue('url(https://x/a.png)')).toEqual([])
  })
})

describe('asset resolution in export', () => {
  function bgDoc(): DocumentModel {
    const doc = docWithAssets()
    doc.nodes = {
      root: node({ id: 'root', tag: 'div', children: ['x', 'y', 'img'] }),
      x: node({ id: 'x', tag: 'div', parent: 'root', style: { 'background-image': 'url(asset://a1)' } }),
      y: node({ id: 'y', tag: 'div', parent: 'root', style: { 'background-image': 'url(asset://a1)' } }),
      img: node({ id: 'img', tag: 'img', parent: 'root', attrs: { src: 'asset://a2', alt: 'b' } }),
    }
    doc.pages[0].children = ['root']
    return doc
  }

  it('HTML defines a reused background asset once via a custom property', () => {
    const html = exportHtml(bgDoc(), 'root')
    // The bytes appear exactly once (the custom-prop def); reuse references var().
    const occurrences = html.split(DATA_A).length - 1
    expect(occurrences).toBe(1)
    expect(html).toContain('--cz-asset-a1: url(')
    expect(html.match(/var\(--cz-asset-a1\)/g)?.length).toBe(2)
  })

  it('HTML inlines an <img src> handle as the data url', () => {
    const html = exportHtml(bgDoc(), 'root')
    expect(html).toContain(`src="${DATA_B}"`)
    expect(html).not.toContain('asset://')
  })

  it('JSX inlines asset handles in both background and img src', () => {
    const jsx = exportJsx(bgDoc(), 'root')
    expect(jsx).toContain(`backgroundImage: 'url("${DATA_A}")'`)
    expect(jsx).toContain(`src="${DATA_B}"`)
    expect(jsx).not.toContain('asset://')
  })

  it('docs with inlined data urls keep exporting unchanged', () => {
    const doc = emptyDocument('d', 'T')
    doc.nodes = {
      root: node({ id: 'root', tag: 'img', attrs: { src: DATA_A, alt: 'x' } }),
    }
    doc.pages[0].children = ['root']
    const html = exportHtml(doc, 'root')
    expect(html).toContain(`src="${DATA_A}"`)
    expect(html).not.toContain('--cz-asset')
  })
})
