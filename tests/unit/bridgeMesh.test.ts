import { describe, expect, it } from 'vitest'
import {
  ProjectRegistry,
  routeCommand,
  subscriptionKey,
} from '#/editor/ai/bridgeMesh'

describe('ProjectRegistry', () => {
  it('tracks ownership and reports the open project union', () => {
    const r = new ProjectRegistry()
    expect(r.add('tabA', 'p1')).toBe(true)
    expect(r.add('tabA', 'p1')).toBe(false) // idempotent
    r.add('tabB', 'p2')
    r.add('tabC', 'p2') // p2 open in two tabs

    expect(r.projects()).toEqual(['p1', 'p2'])
    expect(r.has('p1')).toBe(true)
    expect(r.has('p9')).toBe(false)
  })

  it('most-recently-announced tab owns a project', () => {
    const r = new ProjectRegistry()
    r.add('tabA', 'p1')
    r.add('tabB', 'p1')
    expect(r.ownerOf('p1')).toBe('tabB')
    // When the latest owner leaves, the prior one takes over.
    r.remove('tabB', 'p1')
    expect(r.ownerOf('p1')).toBe('tabA')
  })

  it('drops a project from the union when its last owner leaves', () => {
    const r = new ProjectRegistry()
    r.add('tabA', 'p1')
    r.add('tabB', 'p1')
    r.remove('tabA', 'p1')
    expect(r.has('p1')).toBe(true)
    r.remove('tabB', 'p1')
    expect(r.has('p1')).toBe(false)
    expect(r.projects()).toEqual([])
  })

  it('removeTab clears every project owned by a tab', () => {
    const r = new ProjectRegistry()
    r.add('tabA', 'p1')
    r.add('tabA', 'p2')
    r.add('tabB', 'p2')
    expect(r.removeTab('tabA')).toBe(true)
    expect(r.has('p1')).toBe(false)
    expect(r.ownerOf('p2')).toBe('tabB') // tabB still owns p2
    expect(r.removeTab('tabZ')).toBe(false) // no-op for unknown tab
  })

  it('ownerOf is undefined for an unknown project', () => {
    expect(new ProjectRegistry().ownerOf('nope')).toBeUndefined()
  })
})

describe('subscriptionKey', () => {
  it('is order-independent so the leader does not needlessly reconnect', () => {
    expect(subscriptionKey(['b', 'a', 'c'])).toBe('a,b,c')
    expect(subscriptionKey(['c', 'a', 'b'])).toBe(subscriptionKey(['a', 'b', 'c']))
  })

  it('is empty when no projects are open', () => {
    expect(subscriptionKey([])).toBe('')
  })
})

describe('routeCommand', () => {
  const r = new ProjectRegistry()
  r.add('leader', 'p1') // leader owns p1
  r.add('follower', 'p2') // a sibling owns p2

  it('executes locally when this tab owns the project', () => {
    expect(routeCommand(r, 'leader', 'p1')).toBe('local')
  })

  it('forwards to a sibling when another tab owns the project', () => {
    expect(routeCommand(r, 'leader', 'p2')).toBe('forward')
  })

  it('drops a command for a project nobody in this browser owns', () => {
    expect(routeCommand(r, 'leader', 'gone')).toBe('drop')
  })
})
