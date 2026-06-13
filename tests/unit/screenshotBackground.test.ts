import { describe, expect, it } from 'vitest'
import { resolveBackgroundLayers } from '#/editor/ai/aiTools'
import type { BgLayer } from '#/editor/ai/aiTools'

const TRANSPARENT = 'rgba(0, 0, 0, 0)'
const layer = (p: Partial<BgLayer>): BgLayer => ({
  backgroundColor: TRANSPARENT,
  backgroundImage: 'none',
  ...p,
})

describe('resolveBackgroundLayers', () => {
  it('keeps the node own background when it paints one', () => {
    const bg = resolveBackgroundLayers([
      layer({ own: true, backgroundColor: 'rgb(255, 0, 0)' }),
      layer({ backgroundColor: 'rgb(0, 0, 255)' }),
    ])
    expect(bg.color).toBe('rgb(255, 0, 0)')
    expect(bg.image).toBeUndefined()
    expect(bg.warnings).toEqual([])
  })

  it('pulls the nearest ancestor color when the node is transparent', () => {
    // the #14 hero case: inner div transparent, section paints the background
    const bg = resolveBackgroundLayers([
      layer({ own: true }),
      layer({ backgroundColor: 'rgb(20, 20, 40)' }),
      layer({ isArtboard: true, backgroundColor: 'rgb(255, 255, 255)' }),
    ])
    expect(bg.color).toBe('rgb(20, 20, 40)')
  })

  it('composites an ancestor gradient and warns it is approximate', () => {
    const bg = resolveBackgroundLayers([
      layer({ own: true }),
      layer({ backgroundImage: 'linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))' }),
    ])
    expect(bg.image).toBe('linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))')
    expect(bg.warnings).toHaveLength(1)
    expect(bg.warnings[0]).toMatch(/approximated/)
  })

  it('does not borrow an ancestor image when the node has its own', () => {
    const bg = resolveBackgroundLayers([
      layer({ own: true, backgroundImage: 'url("a.png")' }),
      layer({ backgroundImage: 'linear-gradient(red, blue)' }),
    ])
    expect(bg.image).toBeUndefined()
    expect(bg.warnings).toEqual([])
  })

  it('stops at the artboard and does not warn when nothing is painted', () => {
    const bg = resolveBackgroundLayers([
      layer({ own: true }),
      layer({}),
      layer({ isArtboard: true }),
    ])
    expect(bg.color).toBeUndefined()
    expect(bg.image).toBeUndefined()
    expect(bg.warnings).toEqual([])
  })

  it('takes the nearest color and nearest gradient from different ancestors', () => {
    const bg = resolveBackgroundLayers([
      layer({ own: true }),
      layer({ backgroundColor: 'rgb(10, 10, 10)' }),
      layer({ backgroundImage: 'radial-gradient(white, black)' }),
    ])
    expect(bg.color).toBe('rgb(10, 10, 10)')
    expect(bg.image).toBe('radial-gradient(white, black)')
  })
})
