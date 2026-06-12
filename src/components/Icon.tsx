import { SFSymbol } from './SFSymbol'
import type { SFSymbolProps } from './SFSymbol'

/**
 * App-wide icon component. SF Symbols addressed by free-text Apple names —
 * `<Icon name="gearshape.fill" />` — with chrome-friendly defaults
 * (monochrome, 16px, inherits currentColor). Adjust the defaults here to
 * retheme every icon in the app at once.
 */
export function Icon({ variant = 'monochrome', size = 'md', ...props }: SFSymbolProps) {
  return <SFSymbol variant={variant} size={size} {...props} />
}
