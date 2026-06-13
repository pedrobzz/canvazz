import { describe, expect, it } from 'vitest'
import { parseHtml, sanitizeStyle } from '#/editor/compiler/parse'
import { cssValuePolicyReject, isAllowedCssProp } from '#/editor/compiler/allowlist'

/**
 * Issue #8: value validation. The browser executor uses CSS.supports (covered
 * by e2e — jsdom has no CSS engine), but the layout-model policy and the
 * parse-time half are pure and tested here:
 *   - position: fixed | sticky is rejected everywhere (use absolute).
 *   - valid token/calc/gradient values keep flowing through the sanitizer.
 */

describe('cssValuePolicyReject', () => {
  it('rejects position: fixed and sticky with a reason', () => {
    expect(cssValuePolicyReject('position', 'fixed')).toBe('disallowed value — use absolute')
    expect(cssValuePolicyReject('position', 'sticky')).toBe('disallowed value — use absolute')
    expect(cssValuePolicyReject('position', 'STICKY')).toBe('disallowed value — use absolute')
    expect(cssValuePolicyReject('POSITION', ' fixed ')).toBe('disallowed value — use absolute')
  })

  it('allows the supported position values', () => {
    expect(cssValuePolicyReject('position', 'absolute')).toBeNull()
    expect(cssValuePolicyReject('position', 'relative')).toBeNull()
    expect(cssValuePolicyReject('position', 'static')).toBeNull()
  })

  it('does not touch other properties', () => {
    expect(cssValuePolicyReject('display', 'flex')).toBeNull()
    expect(cssValuePolicyReject('top', '0')).toBeNull()
  })
})

describe('parse-time position policy', () => {
  it('drops position: fixed from an inline style with an actionable reason', () => {
    const dropped: string[] = []
    const style = sanitizeStyle('position: fixed; left: 0; top: 0', dropped)
    expect(style.position).toBeUndefined()
    expect(style.left).toBe('0')
    // The dropped reason carries the substitute, not a bare "disallowed value".
    expect(dropped).toContain('css:position (disallowed value — use absolute)')
  })

  it('drops position: sticky too', () => {
    const dropped: string[] = []
    const style = sanitizeStyle('position: sticky', dropped)
    expect(style.position).toBeUndefined()
    expect(dropped).toContain('css:position (disallowed value — use absolute)')
  })

  it('keeps position: absolute', () => {
    const style = sanitizeStyle('position: absolute')
    expect(style.position).toBe('absolute')
  })

  it('strips position: fixed when parsing whole HTML', () => {
    const dropped: string[] = []
    const { nodes } = parseHtml('<div style="position: fixed; width: 10px">x</div>', {})
    // sanitizeStyle pushes into the parser's own dropped; assert on the node.
    const div = nodes.find((n) => n.tag === 'div')
    expect(div?.style.position).toBeUndefined()
    expect(div?.style.width).toBe('10px')
    void dropped
  })
})

describe('valid CSS values survive the sanitizer (CSS.supports keeps these)', () => {
  it('keeps var(--token) references', () => {
    const style = sanitizeStyle('color: var(--brand); background-color: var(--bg, #fff)')
    expect(style.color).toBe('var(--brand)')
    expect(style['background-color']).toBe('var(--bg, #fff)')
  })

  it('keeps calc() expressions', () => {
    const style = sanitizeStyle('width: calc(100% - 16px); padding: calc(1rem + 2px)')
    expect(style.width).toBe('calc(100% - 16px)')
    expect(style.padding).toBe('calc(1rem + 2px)')
  })

  it('keeps gradients', () => {
    const style = sanitizeStyle('background: linear-gradient(90deg, #fff 0%, #000 100%)')
    expect(style.background).toBe('linear-gradient(90deg, #fff 0%, #000 100%)')
  })

  it('custom properties pass isAllowedCssProp', () => {
    expect(isAllowedCssProp('--brand')).toBe(true)
    expect(isAllowedCssProp('flex-grow')).toBe(true)
    expect(isAllowedCssProp('made-up-prop')).toBe(false)
  })
})
