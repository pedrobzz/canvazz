let counter = 0

/**
 * Stable, human-scannable unique ids. Time component keeps ids unique across
 * sessions; counter keeps them unique within a burst.
 */
export function genId(prefix = 'n'): string {
  counter = (counter + 1) % 1296
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`
}
