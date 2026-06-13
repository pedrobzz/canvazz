import { describe, expect, it } from 'vitest'
import { parseHtml, sanitizeStyle } from '#/editor/compiler/parse'
import { classifyUrl, sanitizeCssUrls, sanitizeUrl } from '#/editor/compiler/allowlist'

/**
 * One url() policy across every url-bearing CSS property (shorthand AND
 * longhand) and across <img src>. data:/asset:// are safe; same-doc #fragments
 * and relative paths are safe; external http(s) is KEPT in both CSS and <img
 * src> (placeholder imagery, #31) and reported so callers can warn (the canvas
 * then depends on the network — prefer import_asset). Only unsafe refs (script,
 * non-image data) are stripped.
 */

describe('classifyUrl', () => {
  it('treats data: images and asset:// refs as safe', () => {
    expect(classifyUrl('data:image/png;base64,AAAA')).toBe('safe')
    expect(classifyUrl('data:image/svg+xml;base64,AAAA')).toBe('safe')
    expect(classifyUrl('asset://abc-123')).toBe('safe')
  })

  it('treats same-document fragments and relative paths as safe', () => {
    expect(classifyUrl('#grad')).toBe('safe')
    expect(classifyUrl('/local/x.png')).toBe('safe')
    expect(classifyUrl('./x.png')).toBe('safe')
    expect(classifyUrl('images/x.png')).toBe('safe')
  })

  it('treats external http(s) as external', () => {
    expect(classifyUrl('https://example.com/bg.png')).toBe('external')
    expect(classifyUrl('http://example.com/bg.png')).toBe('external')
  })

  it('treats scripting and non-image data as unsafe', () => {
    expect(classifyUrl('javascript:alert(1)')).toBe('unsafe')
    expect(classifyUrl('data:text/html,<x>')).toBe('unsafe')
    expect(classifyUrl('')).toBe('unsafe')
  })
})

describe('sanitizeCssUrls — uniform across shorthand and longhand', () => {
  it('keeps external url() in the background shorthand, reporting it', () => {
    const { value, dropped, external } = sanitizeCssUrls('#fff url(https://example.com/bg.png) no-repeat')
    expect(value).toBe('#fff url(https://example.com/bg.png) no-repeat')
    expect(dropped).toEqual([])
    expect(external).toEqual(['https://example.com/bg.png'])
  })

  it('keeps external url() in background-image longhand, reporting it', () => {
    const { value, dropped, external } = sanitizeCssUrls('url("https://example.com/bg.png")')
    expect(value).toBe('url("https://example.com/bg.png")')
    expect(dropped).toEqual([])
    expect(external).toEqual(['https://example.com/bg.png'])
  })

  it('strips an unsafe (non-image data) url(), reporting it in dropped', () => {
    const { value, dropped, external } = sanitizeCssUrls('url(data:text/html,<x>)')
    expect(value).toBe('')
    expect(dropped).toEqual(['unsafe'])
    expect(external).toEqual([])
  })

  it('keeps data: url() untouched', () => {
    const { value, dropped } = sanitizeCssUrls('url(data:image/png;base64,AAAA)')
    expect(value).toBe('url(data:image/png;base64,AAAA)')
    expect(dropped).toEqual([])
  })

  it('keeps asset:// url() untouched', () => {
    const { value, dropped } = sanitizeCssUrls('url(asset://logo-1)')
    expect(value).toBe('url(asset://logo-1)')
    expect(dropped).toEqual([])
  })

  it('keeps same-doc #fragment url() (svg paint server) untouched', () => {
    const { value, dropped } = sanitizeCssUrls('url(#grad)')
    expect(value).toBe('url(#grad)')
    expect(dropped).toEqual([])
  })
})

describe('sanitizeStyle url() policy is identical shorthand vs longhand', () => {
  it('keeps an external url() in a background shorthand and warns', () => {
    const dropped: string[] = []
    const warnings: string[] = []
    const style = sanitizeStyle('background: #fff url(https://example.com/bg.png) no-repeat', dropped, warnings)
    expect(style.background).toBe('#fff url(https://example.com/bg.png) no-repeat')
    expect(dropped).not.toContain('css:background url(external)')
    expect(warnings.some((w) => w.includes('css:background') && w.includes('https://example.com/bg.png') && w.includes('prefer import_asset'))).toBe(true)
  })

  it('keeps an external background-image longhand and warns', () => {
    const dropped: string[] = []
    const warnings: string[] = []
    const style = sanitizeStyle('background-image: url(https://example.com/bg.png)', dropped, warnings)
    expect(style['background-image']).toBe('url(https://example.com/bg.png)')
    expect(warnings.some((w) => w.includes('css:background-image') && w.includes('prefer import_asset'))).toBe(true)
  })

  it('keeps data: and asset:// across shorthand and longhand', () => {
    const a = sanitizeStyle('background: url(data:image/png;base64,AAAA)')
    expect(a.background).toBe('url(data:image/png;base64,AAAA)')
    const b = sanitizeStyle('background-image: url(asset://hero-1)')
    expect(b['background-image']).toBe('url(asset://hero-1)')
  })

  it('keeps external mask-image/border-image and warns; data:/asset:// untouched', () => {
    const dropped: string[] = []
    const warnings: string[] = []
    const style = sanitizeStyle(
      'mask-image: url(https://x.test/m.png); ' +
        'border-image: url(https://x.test/b.png) 30; ' +
        'list-style-image: url(asset://bullet-1)',
      dropped,
      warnings,
    )
    expect(style['mask-image']).toBe('url(https://x.test/m.png)')
    expect(style['border-image']).toBe('url(https://x.test/b.png) 30')
    expect(style['list-style-image']).toBe('url(asset://bullet-1)')
    expect(warnings.some((w) => w.includes('css:mask-image'))).toBe(true)
    expect(warnings.some((w) => w.includes('css:border-image'))).toBe(true)
  })

  it('drops a declaration whose url() carries a javascript: payload', () => {
    const dropped: string[] = []
    const style = sanitizeStyle('background: url(javascript:alert(1))', dropped)
    expect(style.background).toBeUndefined()
    expect(dropped).toContain('css:background')
  })
})

describe('sanitizeUrl for <img src> / <a href>', () => {
  it('keeps data:, asset://, relative, and external http(s)', () => {
    expect(sanitizeUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(sanitizeUrl('asset://photo-1')).toBe('asset://photo-1')
    expect(sanitizeUrl('/local/a.png')).toBe('/local/a.png')
    expect(sanitizeUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  it('rejects javascript: and other unsafe schemes', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeUrl('data:text/html,<x>')).toBeNull()
  })
})

describe('parseHtml warnings for external <img src>', () => {
  it('keeps an external img src and reports it in warnings', () => {
    const { nodes, warnings } = parseHtml('<img src="https://cdn.test/photo.png" alt="x">')
    const img = nodes.find((n) => n.tag === 'img')
    expect(img?.attrs.src).toBe('https://cdn.test/photo.png')
    expect(warnings).toBeDefined()
    expect(warnings?.some((w) => w.includes('img src kept') && w.includes('https://cdn.test/photo.png'))).toBe(true)
    expect(warnings?.some((w) => w.includes('prefer import_asset'))).toBe(true)
  })

  it('does not warn for data: or asset:// img src', () => {
    const data = parseHtml('<img src="data:image/png;base64,AAAA">')
    expect(data.warnings).toBeUndefined()
    const asset = parseHtml('<img src="asset://photo-1">')
    expect(asset.nodes.find((n) => n.tag === 'img')?.attrs.src).toBe('asset://photo-1')
    expect(asset.warnings).toBeUndefined()
  })

  it('does not warn for external <a href> (links to sites are normal)', () => {
    const { warnings } = parseHtml('<a href="https://example.com">link</a>')
    expect(warnings).toBeUndefined()
  })

  it('omits the warnings field entirely when there is nothing to warn about', () => {
    const result = parseHtml('<div style="color: red">hi</div>')
    expect(result.warnings).toBeUndefined()
  })
})
