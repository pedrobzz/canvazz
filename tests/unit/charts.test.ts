import { describe, expect, it } from 'vitest'
import { buildChart } from '#/editor/charts'
import { parseHtml } from '#/editor/compiler/parse'
import type { ChartType } from '#/editor/charts'

/** Pull every `name:value` pair out of an inline-style string. */
function styleOf(markup: string, declaration: RegExp): number[] {
  return [...markup.matchAll(declaration)].map((m) => parseFloat(m[1]))
}

const widths = (markup: string) => styleOf(markup, /width:([\d.]+)px/g)

/** Bar heights in datum order: only the filled (background-color) bar divs. */
function barHeightsOf(markup: string): number[] {
  return [...markup.matchAll(/height:([\d.]+)px;background-color:/g)].map((m) => parseFloat(m[1]))
}

describe('buildChart — bar', () => {
  it('produces one positioned div per datum, scaled to the value range', () => {
    const { markup } = buildChart({ type: 'bar', data: [3, 5, 2, 8, 6, 7, 4], height: 100 })
    // Seven bars (each an absolutely-positioned div) + the relative root.
    const bars = [...markup.matchAll(/data-cz-name="Bar \d+"/g)]
    expect(bars).toHaveLength(7)
    // Tallest value (8) maps to the full plot height; smallest (2) is shortest.
    const barHeights = barHeightsOf(markup)
    expect(barHeights).toHaveLength(7)
    expect(Math.max(...barHeights)).toBeCloseTo(100, 0)
    expect(barHeights[3]).toBeGreaterThan(barHeights[2]) // value 8 > value 2
  })

  it('survives the sanitizer as plain editable divs', () => {
    const { markup } = buildChart({ type: 'bar', data: [1, 2, 3] })
    const { nodes, rootIds, dropped } = parseHtml(markup)
    expect(rootIds).toHaveLength(1)
    expect(nodes.filter((n) => n.tag === 'div').length).toBeGreaterThanOrEqual(4) // root + 3 bars
    expect(dropped.filter((d) => d.startsWith('tag:'))).toHaveLength(0)
    expect(nodes.find((n) => n.name === 'Bar 1')).toBeTruthy()
  })

  it('a flat series renders equal full-height bars (no divide-by-zero)', () => {
    const { markup } = buildChart({ type: 'bar', data: [4, 4, 4], height: 80 })
    const barHeights = barHeightsOf(markup)
    expect(new Set(barHeights.map((h) => Math.round(h))).size).toBe(1)
    expect(barHeights[0]).toBeCloseTo(80, 0)
  })

  it('handles negative values with a shared zero baseline', () => {
    const { markup } = buildChart({ type: 'bar', data: [-5, 5], height: 100 })
    const barHeights = barHeightsOf(markup)
    // -5 and +5 are equal magnitude → equal bar heights around zero.
    expect(barHeights[0]).toBeCloseTo(barHeights[1], 1)
  })

  it('a single point still yields a non-degenerate bar', () => {
    const { markup } = buildChart({ type: 'bar', data: [7], height: 100, width: 60 })
    expect([...markup.matchAll(/data-cz-name="Bar 1"/g)]).toHaveLength(1)
    expect(barHeightsOf(markup)[0]).toBeCloseTo(100, 0)
  })

  it('uses {label,value} labels for bar names and label text', () => {
    const { markup } = buildChart({
      type: 'bar',
      data: [{ label: 'Mon', value: 3 }, { label: 'Tue', value: 9 }],
      labels: true,
    })
    expect(markup).toContain('data-cz-name="Mon"')
    expect(markup).toContain('data-cz-name="Tue"')
    expect(markup).toContain('>Mon<')
  })
})

describe('buildChart — line / sparkline', () => {
  it('emits one SVG path through every data point', () => {
    const { markup } = buildChart({ type: 'line', data: [1, 4, 2, 8], width: 100, height: 50 })
    const path = /<path[^>]*\sd="([^"]+)"/.exec(markup)?.[1] ?? ''
    // 4 points → one move + three line-tos.
    expect((path.match(/L /g) ?? []).length).toBe(3)
    expect(path.startsWith('M ')).toBe(true)
    const { nodes, dropped } = parseHtml(markup)
    expect(nodes.some((n) => n.tag === 'svg')).toBe(true)
    expect(nodes.some((n) => n.tag === 'path' && n.attrs.d)).toBe(true)
    expect(dropped.filter((d) => d.startsWith('tag:'))).toHaveLength(0)
  })

  it('inverts the y-axis so larger values sit higher (smaller y)', () => {
    const { markup } = buildChart({ type: 'line', data: [1, 9], width: 100, height: 50 })
    const path = /<path[^>]*\sd="([^"]+)"/.exec(markup)?.[1] ?? ''
    const ys = [...path.matchAll(/[\d.]+ ([\d.]+)/g)].map((m) => parseFloat(m[1]))
    expect(ys[1]).toBeLessThan(ys[0]) // value 9 plotted above value 1
  })

  it('a single point draws a flat stroke (no NaN coordinates)', () => {
    const { markup } = buildChart({ type: 'sparkline', data: [5], width: 80, height: 20 })
    const path = /<path[^>]*\sd="([^"]+)"/.exec(markup)?.[1] ?? ''
    expect(path).not.toContain('NaN')
    expect(path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/)
  })

  it('a flat series produces finite, mid-height coordinates', () => {
    const { markup } = buildChart({ type: 'line', data: [3, 3, 3], width: 90, height: 30 })
    const path = /<path[^>]*\sd="([^"]+)"/.exec(markup)?.[1] ?? ''
    expect(path).not.toContain('NaN')
    expect(path).not.toContain('Infinity')
  })
})

describe('buildChart — donut', () => {
  it('one arc per slice with dash lengths proportional to value', () => {
    const { markup } = buildChart({ type: 'donut', data: [25, 75], width: 100, height: 100 })
    const dashes = [...markup.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => parseFloat(m[1]))
    expect(dashes).toHaveLength(2)
    // 75 is three times 25 → its arc length is ~3x.
    expect(dashes[1] / dashes[0]).toBeCloseTo(3, 1)
  })

  it('arc lengths sum to the ring circumference', () => {
    const { markup } = buildChart({ type: 'donut', data: [10, 20, 30, 40], width: 120, height: 120 })
    const dashes = [...markup.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)]
      .map((m) => parseFloat(m[1]))
    const size = 120
    const stroke = Math.max(6, size * 0.16)
    const r = (size - stroke) / 2
    const circumference = 2 * Math.PI * r
    const sum = dashes.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(circumference, 0)
  })

  it('ignores negative values in the ring total', () => {
    const a = buildChart({ type: 'donut', data: [50, 50] }).markup
    const b = buildChart({ type: 'donut', data: [50, 50, -10] }).markup
    const firstDash = (m: string) => parseFloat(/stroke-dasharray="([\d.]+) /.exec(m)?.[1] ?? '0')
    // The -10 contributes 0, so the first slice keeps its half-ring length.
    expect(firstDash(b)).toBeCloseTo(firstDash(a), 1)
  })

  it('all-zero data renders just the track (no slices, no NaN)', () => {
    const { markup } = buildChart({ type: 'donut', data: [0, 0] })
    expect(markup).not.toContain('NaN')
    expect(markup).toContain('data-cz-name="Track"')
    expect(markup).not.toContain('Slice')
    const { nodes } = parseHtml(markup)
    expect(nodes.some((n) => n.tag === 'circle')).toBe(true)
  })

  it('survives the sanitizer as circle nodes', () => {
    const { markup } = buildChart({ type: 'donut', data: [1, 2, 3] })
    const { nodes, dropped } = parseHtml(markup)
    expect(nodes.filter((n) => n.tag === 'circle').length).toBe(4) // track + 3 slices
    expect(dropped.filter((d) => d.startsWith('tag:'))).toHaveLength(0)
  })
})

describe('buildChart — defaults & dimensions', () => {
  it('falls back to default size and ignores non-positive overrides', () => {
    const { markup } = buildChart({ type: 'bar', data: [1, 2], width: 0, height: -5 })
    expect(widths(markup)).toContain(240) // default width on the root
  })

  it('every type returns a named, non-empty markup root', () => {
    for (const type of ['bar', 'line', 'sparkline', 'donut'] as ChartType[]) {
      const { markup, name } = buildChart({ type, data: [1, 2, 3] })
      expect(markup).toContain(`data-cz-name="${name}"`)
      expect(parseHtml(markup).rootIds).toHaveLength(1)
    }
  })

  it('threads var(--token) colors through without mangling', () => {
    const { markup } = buildChart({ type: 'bar', data: [1, 2], color: 'var(--brand)' })
    expect(markup).toContain('background-color:var(--brand)')
    const { nodes } = parseHtml(markup)
    expect(nodes.some((n) => n.style['background-color'] === 'var(--brand)')).toBe(true)
  })
})
