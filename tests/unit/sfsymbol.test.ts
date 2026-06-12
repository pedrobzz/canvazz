import { describe, expect, it, vi } from 'vitest'
import { loadSFRegistry, resolveSFComponent, sfComponentName, sfSymbolMarkup } from '@/components/SFSymbol'
import { parseHtml } from '#/editor/compiler/parse'

describe('SFSymbol', () => {
  it('maps Apple names to component names', () => {
    expect(sfComponentName('house.fill')).toBe('SFHouseFill')
    expect(sfComponentName('arrow.up.right')).toBe('SFArrowUpRight')
    expect(sfComponentName('00.circle')).toBe('SF00Circle')
    expect(sfComponentName('heart')).toBe('SFHeart')
  })

  it('resolves real symbols from the registry', async () => {
    const registry = await loadSFRegistry('monochrome')
    expect(resolveSFComponent(registry, 'house.fill')).toBeTruthy()
    expect(resolveSFComponent(registry, 'pills.fill')).toBeTruthy()
    expect(resolveSFComponent(registry, 'definitely.not.a.symbol')).toBeNull()
  })

  it('renders markup that survives the canvas sanitizer', async () => {
    const markup = await sfSymbolMarkup('heart.fill', {
      variant: 'monochrome',
      size: 48,
      style: { position: 'absolute', left: '10px', top: '20px', color: '#ff0000' },
      layerName: 'Heart',
    })
    expect(markup).toBeTruthy()
    expect(markup).toContain('<svg')
    expect(markup).toContain('data-cz-name="Heart"')

    const { nodes, rootIds, dropped } = parseHtml(markup ?? '')
    const root = nodes.find((n) => n.id === rootIds[0])
    expect(root?.tag).toBe('svg')
    expect(root?.name).toBe('Heart')
    expect(root?.style.position).toBe('absolute')
    expect(root?.style.color).toBe('#ff0000')
    // The glyph paths made it through intact.
    expect(nodes.some((n) => n.tag === 'path' && n.attrs.d)).toBe(true)
    expect(dropped.filter((d) => d.startsWith('tag:'))).toHaveLength(0)
  })

  it('returns null and warns for unknown symbols', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sfSymbolMarkup('not.a.real.symbol')).toBeNull()
    warn.mockRestore()
  })
})
