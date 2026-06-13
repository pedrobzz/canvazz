import { describe, expect, it } from 'vitest'
import { clampRegion } from '#/editor/ai/aiTools'

describe('clampRegion', () => {
  it('defaults to the whole node when no region is given', () => {
    expect(clampRegion(undefined, 1440, 4425)).toEqual({ x: 0, y: 0, width: 1440, height: 4425 })
    expect(clampRegion({}, 1440, 4425)).toEqual({ x: 0, y: 0, width: 1440, height: 4425 })
  })

  it('reads a band of a tall artboard at 1:1', () => {
    expect(clampRegion({ x: 0, y: 1200, width: 1440, height: 1200 }, 1440, 4425)).toEqual({
      x: 0, y: 1200, width: 1440, height: 1200,
    })
  })

  it('runs to the node edge when width/height are omitted', () => {
    expect(clampRegion({ x: 0, y: 4000 }, 1440, 4425)).toEqual({ x: 0, y: 4000, width: 1440, height: 425 })
  })

  it('clamps a region that overflows the node box', () => {
    // requesting a 2000-tall band starting at y=4000 of a 4425-tall node
    expect(clampRegion({ x: 0, y: 4000, width: 1440, height: 2000 }, 1440, 4425)).toEqual({
      x: 0, y: 4000, width: 1440, height: 425,
    })
  })

  it('pulls an out-of-range origin back inside the box', () => {
    const r = clampRegion({ x: 5000, y: 9000, width: 100, height: 100 }, 1440, 4425)
    expect(r.x).toBeLessThan(1440)
    expect(r.y).toBeLessThan(4425)
    expect(r.width).toBeGreaterThanOrEqual(1)
    expect(r.height).toBeGreaterThanOrEqual(1)
    expect(r.x + r.width).toBeLessThanOrEqual(1440)
    expect(r.y + r.height).toBeLessThanOrEqual(4425)
  })

  it('rounds fractional coordinates', () => {
    expect(clampRegion({ x: 10.6, y: 20.2, width: 100.9, height: 50.4 }, 1440, 4425)).toEqual({
      x: 11, y: 20, width: 101, height: 50,
    })
  })

  it('never returns a zero-size crop', () => {
    const r = clampRegion({ x: 1439, y: 4424, width: 0, height: 0 }, 1440, 4425)
    expect(r.width).toBeGreaterThanOrEqual(1)
    expect(r.height).toBeGreaterThanOrEqual(1)
  })
})
