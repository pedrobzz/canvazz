import { sfSymbolMarkup } from '@/components/SFSymbol'
import type { SFVariant } from '@/components/SFSymbol'
import { locate, replaceNodeHtml } from './commands'
import { px } from './canvas/geometry'
import type { CommandCtx } from './commands'
import type { NodeId } from './model/types'

/**
 * Icon commands. Swapping or seeding an SF Symbol on the canvas means
 * regenerating its sanitized SVG markup and replacing the target node in
 * place — preserving placement and color so the icon stays where it was.
 */

const PLACEMENT = ['position', 'left', 'top', 'right', 'bottom'] as const

export interface SwapIconOptions {
  variant?: SFVariant
  /** Override pixel size; defaults to the target's current rendered size. */
  size?: number
  /** Override glyph color; defaults to the target's color (else currentColor). */
  color?: string
}

/**
 * Replace any node (a hand-authored glyph span, an old icon, anything) with
 * an SF Symbol, inheriting the target's placement and color. Returns the new
 * node id, or null if the symbol name is unknown.
 */
export async function replaceNodeWithIcon(
  ctx: CommandCtx,
  targetId: NodeId,
  name: string,
  opts: SwapIconOptions = {},
): Promise<NodeId | null> {
  const { store } = ctx
  const node = store.doc.nodes[targetId]
  if (!node || !locate(store, targetId)) return null

  const style: Record<string, string> = {}
  for (const prop of PLACEMENT) if (node.style[prop]) style[prop] = node.style[prop]
  const color = opts.color ?? node.style.color
  if (color) style.color = color

  const size =
    opts.size ??
    px(node.style.width) ??
    (node.attrs.width ? parseFloat(node.attrs.width) || undefined : undefined) ??
    (px(node.style['font-size']) ? Math.round((px(node.style['font-size']) ?? 16) + 6) : undefined) ??
    24

  const markup = await sfSymbolMarkup(name.trim(), {
    variant: opts.variant ?? 'monochrome',
    size,
    style,
    layerName: name.trim(),
  })
  if (!markup) return null

  const { rootIds } = replaceNodeHtml(ctx, targetId, markup, `Set icon ${name.trim()}`)
  return rootIds[0] ?? null
}
