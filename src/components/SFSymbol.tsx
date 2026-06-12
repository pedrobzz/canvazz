import { useEffect, useSyncExternalStore } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ComponentType, SVGProps } from 'react'

/**
 * SF Symbols (7,007 icons via sf-symbols-lib) addressed by their Apple name:
 * "house.fill" → SFHouseFill. The variant registries are huge, so they load
 * lazily as async chunks and cache; components render null until ready and
 * re-render when the registry lands.
 */

export type SFVariant = 'dualtone' | 'monochrome'
export type SFSize = number | 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export type SFSymbolProps = {
  /** Apple symbol name, e.g. "house.fill", "heart", "cross.case.fill". */
  name: string
  variant?: SFVariant
  size?: SFSize
  className?: string
} & SVGProps<SVGSVGElement>

type IconComponent = ComponentType<{ size?: SFSize; className?: string } & SVGProps<SVGSVGElement>>
type Registry = Record<string, IconComponent>

const cache: Partial<Record<SFVariant, Registry>> = {}
const pending: Partial<Record<SFVariant, Promise<Registry>>> = {}
const listeners = new Set<() => void>()

/** Load (and cache) a variant's icon registry. Safe to call repeatedly. */
export function loadSFRegistry(variant: SFVariant): Promise<Registry> {
  const ready = cache[variant]
  if (ready) return Promise.resolve(ready)
  pending[variant] ??= (
    variant === 'dualtone' ? import('sf-symbols-lib/dualtone') : import('sf-symbols-lib/monochrome')
  ).then((mod) => {
    cache[variant] = mod as unknown as Registry
    for (const fn of listeners) fn()
    return cache[variant] as Registry
  })
  return pending[variant] as Promise<Registry>
}

function useRegistry(variant: SFVariant): Registry | null {
  const registry = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => cache[variant] ?? null,
    () => null,
  )
  useEffect(() => {
    if (!registry) void loadSFRegistry(variant)
  }, [variant, registry])
  return registry
}

/** "house.fill" → "SFHouseFill" */
export function sfComponentName(name: string): string {
  return (
    'SF' +
    name
      .trim()
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
  )
}

export function resolveSFComponent(registry: Registry | null, name: string): IconComponent | null {
  if (!registry) return null
  return registry[sfComponentName(name)] ?? null
}

export function SFSymbol({ name, variant = 'dualtone', size = 'lg', className, ...props }: SFSymbolProps) {
  const registry = useRegistry(variant)
  if (!registry) return null
  const IconComponent = resolveSFComponent(registry, name)
  if (!IconComponent) {
    console.warn(`SFSymbol: Icon "${name}" not found`)
    return null
  }
  return <IconComponent size={size} className={className} {...props} />
}

/**
 * Static SVG markup for a symbol — the bridge onto the Canvazz canvas, where
 * icons become regular sanitized model nodes (editable, exportable).
 */
export async function sfSymbolMarkup(
  name: string,
  opts: { variant?: SFVariant; size?: number; style?: Record<string, string>; layerName?: string } = {},
): Promise<string | null> {
  const registry = await loadSFRegistry(opts.variant ?? 'dualtone')
  const IconComponent = resolveSFComponent(registry, name)
  if (!IconComponent) return null
  const markup = renderToStaticMarkup(
    createElement(IconComponent, { size: opts.size ?? 24 }),
  )
  const style = opts.style
    ? ` style="${Object.entries(opts.style).map(([k, v]) => `${k}:${v}`).join(';')}"`
    : ''
  const variant = opts.variant ?? 'dualtone'
  const layer = ` data-cz-name="${(opts.layerName ?? name).replace(/"/g, '')}"`
  // Round-trip the symbol identity so the inspector can swap it later.
  const annot = ` data-cz-icon="${name.replace(/"/g, '')}" data-cz-variant="${variant}"`
  return markup.replace('<svg', `<svg${layer}${annot}${style}`)
}
