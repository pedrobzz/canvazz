/**
 * Chart generator. Pure markup builders (no runtime dependency, no widget):
 * given data + options they emit ordinary, restylable canvas nodes — div bars,
 * a single SVG path for lines, SVG arcs for donuts — which the caller inserts
 * through the normal HTML path. Every shape carries a data-cz-name so the
 * layer tree reads like a chart ("Bar 1", "Slice 2", …).
 *
 * Sizing is in absolute px throughout: a bar's height is `${n}px`, never a
 * percentage, because a percentage height inside an auto-height (fit-content)
 * parent collapses to 0 — the exact trap this primitive removes.
 */

export type ChartType = 'bar' | 'line' | 'sparkline' | 'donut'

export interface ChartDatum {
  label?: string
  value: number
}

export interface ChartSpec {
  type: ChartType
  data: number[] | ChartDatum[]
  width?: number
  height?: number
  /** Series / fill color (CSS color or var(--token)). */
  color?: string
  /** Donut unfilled-track color. */
  trackColor?: string
  /** Render value/category labels where the chart type supports them. */
  labels?: boolean
}

export interface ChartResult {
  markup: string
  /** Layer name of the chart root, for reporting. */
  name: string
}

const DEFAULTS = { width: 240, height: 140, color: '#6366f1', trackColor: '#e5e7eb' }

function normalize(data: number[] | ChartDatum[]): ChartDatum[] {
  return (data as Array<number | ChartDatum>).map((d) =>
    typeof d === 'number' ? { value: d } : { label: d.label, value: d.value ?? 0 },
  )
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c
))

/** A px string with 2-decimal precision and no trailing zeros. */
const u = (n: number): string => `${Math.round(n * 100) / 100}`

/**
 * Map a value range onto a pixel span. The baseline sits at zero when the data
 * straddles it, otherwise at the smaller extreme, so bars grow from a sensible
 * floor and a single-point series still has a non-degenerate scale.
 */
function scaleOf(values: number[], span: number) {
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 0 }
  const base = min < 0 && max > 0 ? 0 : Math.min(min, 0)
  const top = Math.max(max, base)
  const range = top - base || 1 // flat series → full-height-safe unit scale
  return {
    base,
    /** Pixels from the baseline for a value (can be negative for below-zero). */
    px: (v: number) => ((v - base) / range) * span,
    /** Pixel y (top-origin) for a value in a `span`-tall plot. */
    y: (v: number) => span - ((v - base) / range) * span,
  }
}

function barChart(d: ChartDatum[], o: Required<Omit<ChartSpec, 'type' | 'data'>>): string {
  const { width, height, color } = o
  const n = Math.max(d.length, 1)
  const gap = n > 1 ? Math.min(12, width / (n * 4)) : 0
  const slot = (width - gap * (n - 1)) / n
  const plotH = o.labels ? height - 18 : height
  const s = scaleOf(d.map((x) => x.value), plotH)
  const zeroY = plotH - s.px(0) // baseline offset from the plot top

  const bars = d.map((datum, i) => {
    const h = Math.abs(s.px(datum.value))
    const top = datum.value >= 0 ? zeroY - h : zeroY
    const left = i * (slot + gap)
    const name = esc(datum.label ?? `Bar ${i + 1}`)
    const bar =
      `<div data-cz-name="${name}" style="position:absolute;left:${u(left)}px;top:${u(Math.max(0, top))}px;` +
      `width:${u(slot)}px;height:${u(Math.max(1, h))}px;background-color:${esc(color)};border-radius:3px"></div>`
    const label = o.labels
      ? `<div data-cz-name="${name} label" style="position:absolute;left:${u(left)}px;top:${u(plotH + 2)}px;` +
        `width:${u(slot)}px;height:14px;font-size:10px;text-align:center;color:#6b7280">${esc(datum.label ?? String(datum.value))}</div>`
      : ''
    return bar + label
  }).join('')

  return (
    `<div data-cz-name="Bar chart" style="position:relative;width:${u(width)}px;height:${u(height)}px">` +
    bars +
    `</div>`
  )
}

/** Build the polyline points + an SVG path string for a value series. */
function linePoints(d: ChartDatum[], width: number, height: number, pad: number) {
  const values = d.map((x) => x.value)
  const plotW = width - pad * 2
  const plotH = height - pad * 2
  const s = scaleOf(values, plotH)
  const n = d.length
  const step = n > 1 ? plotW / (n - 1) : 0
  return d.map((datum, i) => ({
    x: pad + (n > 1 ? i * step : plotW / 2),
    y: pad + s.y(datum.value),
  }))
}

function lineChart(d: ChartDatum[], o: Required<Omit<ChartSpec, 'type' | 'data'>>, spark: boolean): string {
  const { width, height, color } = o
  const pad = spark ? 2 : 8
  const pts = linePoints(d, width, height, pad)
  const path = pts.length === 1
    // A single point has no line; draw a short flat stroke through it.
    ? `M ${u(pad)} ${u(pts[0].y)} L ${u(width - pad)} ${u(pts[0].y)}`
    : `M ${pts.map((p) => `${u(p.x)} ${u(p.y)}`).join(' L ')}`
  const dots = !spark && o.labels
    ? pts.map((p, i) =>
        `<circle data-cz-name="Point ${i + 1}" cx="${u(p.x)}" cy="${u(p.y)}" r="2.5" fill="${esc(color)}" />`,
      ).join('')
    : ''
  return (
    `<svg data-cz-name="${spark ? 'Sparkline' : 'Line chart'}" width="${u(width)}" height="${u(height)}" ` +
    `viewBox="0 0 ${u(width)} ${u(height)}" style="display:block">` +
    `<path data-cz-name="Line" d="${path}" fill="none" stroke="${esc(color)}" ` +
    `stroke-width="${spark ? 1.5 : 2}" stroke-linecap="round" stroke-linejoin="round" />` +
    dots +
    `</svg>`
  )
}

function donutChart(d: ChartDatum[], o: Required<Omit<ChartSpec, 'type' | 'data'>>): string {
  const size = Math.min(o.width, o.height)
  const stroke = Math.max(6, size * 0.16)
  const r = (size - stroke) / 2
  const cx = size / 2
  const circumference = 2 * Math.PI * r
  // Only the non-negative magnitudes contribute to the ring.
  const mags = d.map((x) => Math.max(0, x.value))
  const total = mags.reduce((a, b) => a + b, 0)
  const palette = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16']

  const track =
    `<circle data-cz-name="Track" cx="${u(cx)}" cy="${u(cx)}" r="${u(r)}" fill="none" ` +
    `stroke="${esc(o.trackColor)}" stroke-width="${u(stroke)}" />`

  let offset = 0
  const slices = total === 0 ? '' : d.map((datum, i) => {
    const frac = Math.max(0, datum.value) / total
    const len = frac * circumference
    const color = i === 0 && o.color !== DEFAULTS.color ? o.color : palette[i % palette.length]
    const seg =
      `<circle data-cz-name="${esc(datum.label ?? `Slice ${i + 1}`)}" cx="${u(cx)}" cy="${u(cx)}" r="${u(r)}" ` +
      `fill="none" stroke="${esc(color)}" stroke-width="${u(stroke)}" ` +
      `stroke-dasharray="${u(len)} ${u(circumference - len)}" stroke-dashoffset="${u(-offset)}" ` +
      `transform="rotate(-90 ${u(cx)} ${u(cx)})" stroke-linecap="butt" />`
    offset += len
    return seg
  }).join('')

  return (
    `<svg data-cz-name="Donut chart" width="${u(size)}" height="${u(size)}" ` +
    `viewBox="0 0 ${u(size)} ${u(size)}" style="display:block">` +
    track + slices +
    `</svg>`
  )
}

/**
 * Generate restylable chart markup from a data spec. Pure and DOM-free, so it
 * is unit-testable and reusable by the insert_chart executor.
 */
export function buildChart(spec: ChartSpec): ChartResult {
  const d = normalize(spec.data)
  const o = {
    width: spec.width && spec.width > 0 ? spec.width : DEFAULTS.width,
    height: spec.height && spec.height > 0 ? spec.height : DEFAULTS.height,
    color: spec.color || DEFAULTS.color,
    trackColor: spec.trackColor || DEFAULTS.trackColor,
    labels: spec.labels ?? false,
  }
  switch (spec.type) {
    case 'bar': return { markup: barChart(d, o), name: 'Bar chart' }
    case 'line': return { markup: lineChart(d, o, false), name: 'Line chart' }
    case 'sparkline': return { markup: lineChart(d, o, true), name: 'Sparkline' }
    case 'donut': return { markup: donutChart(d, o), name: 'Donut chart' }
  }
}
