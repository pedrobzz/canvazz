import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getCachedRegistry, loadSFRegistry, resolveSFComponent, sfComponentName } from '@/components/SFSymbol'
import type { SFVariant } from '@/components/SFSymbol'
import { parseHtml } from './compiler/parse'
import { setIconChildrenResolver } from './model/instances'
import type { ResolvedNode } from './model/instances'
import type { NodeModel } from './model/types'

/**
 * Bridges the SF Symbols registry into the pure model resolver: when an
 * instance overrides a vector's data-cz-icon, exports and reads regenerate
 * the glyph content instead of emitting the definition's stale paths.
 * Importing this module registers the resolver.
 */

const memo = new Map<string, { attrs: Record<string, string>; children: ResolvedNode[] }>()

function toResolved(node: NodeModel, byId: Map<string, NodeModel>): ResolvedNode {
  return {
    pathId: node.id,
    sourceId: node.id,
    instanceId: null,
    name: node.name,
    tag: node.tag,
    attrs: node.attrs,
    style: node.style,
    classes: node.classes,
    text: node.text,
    visible: true,
    locked: false,
    children: node.children
      .map((c) => byId.get(c))
      .filter((c): c is NodeModel => Boolean(c))
      .map((c) => toResolved(c, byId)),
  }
}

setIconChildrenResolver((name, variant, size) => {
  const key = `${variant}/${name}/${size}`
  const cached = memo.get(key)
  if (cached) return cached

  const registry = getCachedRegistry(variant as SFVariant)
  if (!registry) {
    void loadSFRegistry(variant as SFVariant) // warm for the next resolve
    return null
  }
  const IconComponent = resolveSFComponent(registry, name)
  if (!IconComponent) return null

  const markup = renderToStaticMarkup(createElement(IconComponent, { size }))
  const { nodes, rootIds } = parseHtml(markup)
  const root = nodes.find((n) => n.id === rootIds[0])
  if (!root || root.tag !== 'svg') return null

  const byId = new Map(nodes.map((n) => [n.id, n]))
  // The new glyph brings its own coordinate space.
  const attrs: Record<string, string> = {}
  if (root.attrs.viewBox) attrs.viewBox = root.attrs.viewBox
  const result = {
    attrs,
    children: root.children
      .map((c) => byId.get(c))
      .filter((c): c is NodeModel => Boolean(c))
      .map((c) => toResolved(c, byId)),
  }
  memo.set(key, result)
  return result
})

/** Both registries loaded — exports of icon overrides are then exact. */
export function ensureIconRegistries(): Promise<unknown> {
  return Promise.all([loadSFRegistry('monochrome'), loadSFRegistry('dualtone')])
}

/**
 * The registry ships only PascalCase component names (`SFArrowUpRight`); the
 * original Apple names (`arrow.up.right`) with their dot boundaries were
 * discarded. Reverse the casing to a dotted name, then verify it round-trips
 * back to the same component via sfComponentName — the only safe proof the
 * name resolves. Casing alone is ambiguous for single-letter segments
 * (`l.joystick`, `poweroutlet.type.a.fill`), so when the naive guess fails we
 * try inserting one dot inside any segment and accept the first split that
 * round-trips. This recovers every one of the 7,007 names exactly.
 */
export function componentToIconName(component: string): string | null {
  const base = component
    .replace(/^SF/, '')
    .replace(/([a-z])([A-Z])/g, '$1.$2')
    .replace(/([A-Za-z])([0-9])/g, '$1.$2')
    .replace(/([0-9])([A-Z])/g, '$1.$2')
    .toLowerCase()
  if (sfComponentName(base) === component) return base
  const segs = base.split('.')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    for (let p = 1; p < seg.length; p++) {
      const cand = [...segs.slice(0, i), seg.slice(0, p), seg.slice(p), ...segs.slice(i + 1)].join('.')
      if (sfComponentName(cand) === component) return cand
    }
  }
  return null
}

const nameCache: Partial<Record<SFVariant, string[]>> = {}

/** Every resolvable Apple icon name in a variant's registry, cached. */
export async function iconNames(variant: SFVariant = 'monochrome'): Promise<string[]> {
  const cached = nameCache[variant]
  if (cached) return cached
  const registry = await loadSFRegistry(variant)
  const names: string[] = []
  for (const key of Object.keys(registry)) {
    if (!key.startsWith('SF')) continue
    const name = componentToIconName(key)
    if (name) names.push(name)
  }
  names.sort()
  nameCache[variant] = names
  return names
}

export interface IconMatch {
  name: string
  score: number
}

/**
 * Plain-English → canonical SF Symbol name. The registry only knows Apple's
 * tokens (`magnifyingglass`, `chevron.left`), so a natural query like "search"
 * or "back" found nothing. We expand the query with these targets and score the
 * union, so the documented "plain English" search actually works. Keys are the
 * words a designer types; values are real SF names.
 */
const ICON_SYNONYMS: Record<string, string> = {
  search: 'magnifyingglass', find: 'magnifyingglass', magnify: 'magnifyingglass',
  back: 'chevron.left', previous: 'chevron.left', forward: 'chevron.right', next: 'chevron.right',
  expand: 'chevron.down', collapse: 'chevron.up',
  close: 'xmark', dismiss: 'xmark', cancel: 'xmark',
  menu: 'line.3.horizontal', hamburger: 'line.3.horizontal', more: 'ellipsis',
  settings: 'gearshape', preferences: 'gearshape', options: 'slider.horizontal.3',
  home: 'house', profile: 'person.crop.circle', user: 'person', account: 'person.crop.circle',
  people: 'person.2', group: 'person.3',
  location: 'mappin', pin: 'mappin', map: 'map', address: 'mappin.and.ellipse',
  call: 'phone', message: 'bubble.left', chat: 'bubble.left.and.bubble.right', comment: 'bubble.right',
  cart: 'cart', basket: 'cart', bag: 'bag', store: 'storefront',
  like: 'heart', favorite: 'heart', love: 'heart.fill',
  share: 'square.and.arrow.up', send: 'paperplane', upload: 'square.and.arrow.up', download: 'square.and.arrow.down',
  notification: 'bell', alert: 'bell', reminder: 'bell',
  add: 'plus', new: 'plus', create: 'plus', remove: 'minus',
  edit: 'pencil', write: 'square.and.pencil', delete: 'trash', bin: 'trash',
  camera: 'camera', photo: 'photo', image: 'photo', picture: 'photo', gallery: 'photo.on.rectangle',
  calendar: 'calendar', date: 'calendar', schedule: 'calendar',
  clock: 'clock', time: 'clock', timer: 'timer',
  lock: 'lock', secure: 'lock', password: 'lock', unlock: 'lock.open',
  star: 'star', rating: 'star', filter: 'line.3.horizontal.decrease', sort: 'arrow.up.arrow.down',
  card: 'creditcard', payment: 'creditcard', wallet: 'wallet.pass', money: 'banknote', bank: 'building.columns',
  check: 'checkmark', done: 'checkmark', info: 'info.circle', help: 'questionmark.circle',
  warning: 'exclamationmark.triangle', error: 'xmark.circle',
  play: 'play.fill', pause: 'pause.fill', stop: 'stop.fill',
  email: 'envelope', mail: 'envelope', inbox: 'tray',
  link: 'link', attach: 'paperclip', file: 'doc', document: 'doc', folder: 'folder',
  refresh: 'arrow.clockwise', reload: 'arrow.clockwise', sync: 'arrow.triangle.2.circlepath',
  logout: 'rectangle.portrait.and.arrow.right', exit: 'rectangle.portrait.and.arrow.right',
  eye: 'eye', view: 'eye', show: 'eye', hide: 'eye.slash',
  bookmark: 'bookmark', gift: 'gift', tag: 'tag', dashboard: 'square.grid.2x2',
  workout: 'figure.run', run: 'figure.run', fitness: 'figure.run', heart_rate: 'heart.text.square',
}

/** Canonical SF targets implied by an English query (whole query + per word). */
function synonymTargets(query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out = new Set<string>()
  if (ICON_SYNONYMS[q]) out.add(ICON_SYNONYMS[q])
  for (const word of q.split(/[\s.]+/)) {
    if (ICON_SYNONYMS[word]) out.add(ICON_SYNONYMS[word])
  }
  return [...out]
}

/**
 * Compact Damerau-free edit distance, capped at `max` so far-apart strings
 * exit early. Only used for the lowest scoring tier (typo recovery), so the
 * cap keeps a 7k-name sweep cheap.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/**
 * Score one icon name against a query. Tiers, high to low:
 *   1000 exact · 800 prefix · 600 substring · token overlap (per shared
 *   dot/word segment) · small-edit-distance fallback. Returns 0 for no signal.
 */
export function scoreIconName(query: string, name: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  if (name === q) return 1000
  if (name.startsWith(q)) return 800 - (name.length - q.length)
  const idx = name.indexOf(q)
  if (idx >= 0) return 600 - idx - (name.length - q.length)

  // Collapsed match: ignore dot/space boundaries so "magnifying glass" hits
  // "magnifyingglass" and "chevron right" hits "chevron.right". Scored just
  // below the equivalent raw tier so a literal token match still wins.
  const qc = q.replace(/[.\s]+/g, '')
  const nc = name.replace(/\./g, '')
  if (qc.length >= 2 && (qc !== q || nc !== name)) {
    if (nc === qc) return 950
    if (nc.startsWith(qc)) return 760 - (nc.length - qc.length)
    const ci = nc.indexOf(qc)
    if (ci >= 0) return 560 - ci - (nc.length - qc.length)
  }

  const qTokens = q.split(/[.\s]+/).filter(Boolean)
  const nTokens = name.split('.')
  const nSet = new Set(nTokens)
  let overlap = 0
  let prefixHits = 0
  for (const t of qTokens) {
    if (nSet.has(t)) overlap++
    // A prefix hit needs ≥3 shared leading chars — otherwise a 1-letter SF
    // token (`g` in g.circle) spuriously matched query words like "glass".
    else if (nTokens.some((n) => Math.min(n.length, t.length) >= 3 && (n.startsWith(t) || t.startsWith(n)))) prefixHits++
  }
  if (overlap > 0 || prefixHits > 0) {
    return 300 + overlap * 80 + prefixHits * 30 - Math.abs(nTokens.length - qTokens.length) * 5
  }

  // Typo tier: only worth the edit-distance walk for short-ish queries.
  if (q.length <= 24) {
    const collapsed = name.replace(/\./g, '')
    const qCollapsed = q.replace(/[.\s]/g, '')
    const max = Math.max(1, Math.floor(qCollapsed.length / 3))
    const dist = Math.min(
      editDistance(qCollapsed, collapsed, max),
      ...nTokens.map((n) => editDistance(qCollapsed, n, max)),
    )
    if (dist <= max) return 120 - dist * 20 - Math.abs(collapsed.length - qCollapsed.length)
  }
  return 0
}

/** Rank a name list by query relevance, best first, dropping non-matches. */
export function scoreIcons(query: string, names: string[], limit: number): IconMatch[] {
  // Score against the literal query AND any plain-English synonym targets, so
  // "search" surfaces magnifyingglass while "magnifyingglass" still wins exact.
  const queries = [query, ...synonymTargets(query)]
  const matches: IconMatch[] = []
  for (const name of names) {
    let score = 0
    for (const q of queries) {
      const s = scoreIconName(q, name)
      if (s > score) score = s
    }
    if (score > 0) matches.push({ name, score })
  }
  matches.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
  return matches.slice(0, limit)
}

/** Top-N names closest to an unknown query — used for "did you mean" errors. */
export async function closestIconNames(query: string, variant: SFVariant, n = 5): Promise<string[]> {
  const names = await iconNames(variant)
  return scoreIcons(query, names, n).map((m) => m.name)
}
