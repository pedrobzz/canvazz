import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getCachedRegistry, loadSFRegistry, resolveSFComponent } from '@/components/SFSymbol'
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
