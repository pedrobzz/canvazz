import { describe, expect, it } from 'vitest'
import { applyOps, emptyDocument } from '#/editor/model/doc'
import { exportHtml } from '#/editor/compiler/export'
import { parseHtml } from '#/editor/compiler/parse'
import type { DocumentModel } from '#/editor/model/types'

/**
 * Issue #9: var(--token) in SVG presentation *attributes* paints nothing
 * (custom properties don't resolve in attribute form). At parse time we move
 * token-bearing presentation values into inline style, where they resolve and
 * live-update; literal values stay as attributes. Export must round-trip.
 */

function intoDoc(html: string): { doc: DocumentModel; rootIds: string[]; dropped: string[] } {
  const { nodes, rootIds, dropped } = parseHtml(html)
  let doc = emptyDocument('d1', 'Test')
  for (const rootId of rootIds) {
    const tree = nodes.filter((n) => n.id === rootId || isDescendant(nodes, n.id, rootId))
    doc = applyOps(doc, [
      { t: 'insertTree', nodes: tree, rootId, at: { kind: 'page', pageId: 'page_1', index: doc.pages[0].children.length } },
    ]).doc
  }
  return { doc, rootIds, dropped }
}

function isDescendant(nodes: Array<{ id: string; parent: string | null }>, id: string, ancestor: string): boolean {
  let cur = nodes.find((n) => n.id === id)?.parent ?? null
  while (cur) {
    if (cur === ancestor) return true
    cur = nodes.find((n) => n.id === cur)?.parent ?? null
  }
  return false
}

describe('SVG var() relocation', () => {
  it('moves stroke="var(--token)" from attribute into inline style', () => {
    const { nodes } = parseHtml(
      '<svg viewBox="0 0 92 92"><circle data-cz-id="c1" cx="46" cy="46" r="40" stroke="var(--ring-track)" stroke-width="9"></circle></svg>',
    )
    const circle = nodes.find((n) => n.id === 'c1')!
    // var() value relocated to style; not left as a (non-painting) attribute.
    expect(circle.style.stroke).toBe('var(--ring-track)')
    expect(circle.attrs.stroke).toBeUndefined()
    // Literal sibling attribute stays an attribute.
    expect(circle.attrs['stroke-width']).toBe('9')
    expect(circle.style['stroke-width']).toBeUndefined()
  })

  it('relocates fill, stop-color, and other presentation var() values', () => {
    const { nodes } = parseHtml(
      '<svg><rect data-cz-id="r1" fill="var(--brand)" fill-opacity="var(--o)"></rect>' +
        '<defs><linearGradient><stop data-cz-id="s1" stop-color="var(--accent)" offset="0"></stop></linearGradient></defs></svg>',
    )
    const rect = nodes.find((n) => n.id === 'r1')!
    expect(rect.style.fill).toBe('var(--brand)')
    expect(rect.style['fill-opacity']).toBe('var(--o)')
    const stop = nodes.find((n) => n.id === 's1')!
    expect(stop.style['stop-color']).toBe('var(--accent)')
    // offset is geometry, not a CSS paint prop — stays an attribute.
    expect(stop.attrs.offset).toBe('0')
  })

  it('keeps literal presentation attributes as attributes', () => {
    const { nodes } = parseHtml(
      '<svg><circle data-cz-id="c2" stroke="#f00" fill="none"></circle></svg>',
    )
    const circle = nodes.find((n) => n.id === 'c2')!
    expect(circle.attrs.stroke).toBe('#f00')
    expect(circle.attrs.fill).toBe('none')
    expect(circle.style.stroke).toBeUndefined()
    expect(circle.style.fill).toBeUndefined()
  })

  it('lets an explicit inline style win over a relocated var() attribute', () => {
    const { nodes } = parseHtml(
      '<svg><circle data-cz-id="c3" stroke="var(--a)" style="stroke: var(--b)"></circle></svg>',
    )
    const circle = nodes.find((n) => n.id === 'c3')!
    expect(circle.style.stroke).toBe('var(--b)')
  })

  it('round-trips: export emits the var() in style and re-import keeps it rendering', () => {
    const input =
      '<svg data-cz-id="v1" data-cz-name="Ring" viewBox="0 0 92 92"><circle data-cz-id="v5" cx="46" cy="46" r="40" stroke="var(--ring)" fill="none" stroke-width="9"></circle></svg>'
    const { doc } = intoDoc(input)
    const html = exportHtml(doc, 'v1')
    // The token rides in inline style now, where it resolves and live-updates.
    expect(html).toContain('stroke: var(--ring)')
    // Literal fill="none" and stroke-width stay attributes.
    expect(html).toContain('fill="none"')
    expect(html).toContain('stroke-width="9"')

    const second = intoDoc(html)
    const circle = second.doc.nodes.v5
    expect(circle.style.stroke).toBe('var(--ring)')
    expect(circle.attrs.fill).toBe('none')
    expect(circle.attrs['stroke-width']).toBe('9')
    expect(second.dropped).toHaveLength(0)
  })
})
