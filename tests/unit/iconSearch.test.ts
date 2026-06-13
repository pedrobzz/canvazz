import { describe, expect, it } from 'vitest'
import {
  componentToIconName,
  iconNames,
  scoreIconName,
  scoreIcons,
  closestIconNames,
} from '#/editor/iconResolver'

describe('componentToIconName', () => {
  it('reverses straightforward PascalCase to dotted names', () => {
    expect(componentToIconName('SFHouseFill')).toBe('house.fill')
    expect(componentToIconName('SFArrowUpRight')).toBe('arrow.up.right')
    expect(componentToIconName('SF00Circle')).toBe('00.circle')
  })

  it('recovers single-letter segments that casing alone collapses', () => {
    // SFLJoystick is l.joystick, not ljoystick; SFACircle is a.circle.
    expect(componentToIconName('SFLJoystick')).toBe('l.joystick')
    expect(componentToIconName('SFACircle')).toBe('a.circle')
    expect(componentToIconName('SFPoweroutletTypeAFill')).toBe('poweroutlet.type.a.fill')
  })
})

describe('scoreIconName tiers', () => {
  it('ranks exact > prefix > substring', () => {
    const exact = scoreIconName('doc', 'doc')
    const prefix = scoreIconName('doc', 'doc.fill')
    const substring = scoreIconName('doc', 'list.and.doc')
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(0)
  })

  it('rewards shorter prefix matches over longer ones', () => {
    expect(scoreIconName('doc', 'doc.fill')).toBeGreaterThan(scoreIconName('doc', 'doc.text.fill'))
  })

  it('credits token overlap when there is no contiguous match', () => {
    const score = scoreIconName('text doc', 'doc.text.fill')
    expect(score).toBeGreaterThan(0)
    // both query tokens are segments of the name
    expect(score).toBeGreaterThan(scoreIconName('text doc', 'doc.fill'))
  })

  it('recovers typos via small edit distance', () => {
    expect(scoreIconName('hart', 'heart')).toBeGreaterThan(0)
    expect(scoreIconName('hart.fil', 'heart.fill')).toBeGreaterThan(0)
    // a totally unrelated name scores nothing
    expect(scoreIconName('hart', 'trash')).toBe(0)
  })

  it('returns 0 for an empty query', () => {
    expect(scoreIconName('', 'heart')).toBe(0)
  })
})

describe('scoreIcons ranking', () => {
  const names = ['doc', 'doc.fill', 'doc.text', 'doc.text.fill', 'doc.text.image', 'heart', 'trash']

  it('returns the exact match first, capped at limit', () => {
    const out = scoreIcons('doc.text', names, 3)
    expect(out).toHaveLength(3)
    expect(out[0].name).toBe('doc.text')
    expect(out.every((m, i) => i === 0 || out[i - 1].score >= m.score)).toBe(true)
  })

  it('drops names with no signal', () => {
    const out = scoreIcons('doc', names, 50)
    expect(out.some((m) => m.name === 'heart')).toBe(false)
    expect(out.some((m) => m.name === 'trash')).toBe(false)
  })

  it("suggests close names for a typo'd query", () => {
    const out = scoreIcons('doc.txt.fill', names, 5)
    expect(out[0].name).toBe('doc.text.fill')
  })
})

describe('registry-backed search', () => {
  it('enumerates resolvable Apple names', async () => {
    const names = await iconNames('monochrome')
    expect(names.length).toBeGreaterThan(6000)
    expect(names).toContain('house.fill')
    expect(names).toContain('heart')
    expect(names).toContain('l.joystick')
  }, 20_000)

  it('finds useful names for a plain-English query', async () => {
    const names = await iconNames('monochrome')
    const out = scoreIcons('document', names, 12)
    expect(out.length).toBeGreaterThan(0)
    expect(out.some((m) => m.name.startsWith('doc'))).toBe(true)
  }, 20_000)

  it('returns useful, real close matches for an unknown name', async () => {
    // `doc.text.fill` is the canonical "agent kept guessing it" case from #13;
    // it does not exist in this registry, so suggestions must surface the real
    // document symbols instead of nothing.
    const close = await closestIconNames('doc.text.fill', 'monochrome', 5)
    expect(close.length).toBeGreaterThan(0)
    expect(close.some((n) => n.includes('document'))).toBe(true)
    // every suggestion is a real, resolvable name (round-trips by construction)
    const names = await iconNames('monochrome')
    expect(close.every((n) => names.includes(n))).toBe(true)
  }, 20_000)
})
