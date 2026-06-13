import { describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { exportHtml } from '#/editor/compiler/export'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

function node(p: Partial<NodeModel> & Pick<NodeModel, 'id' | 'tag'>): NodeModel {
  return {
    name: p.id, attrs: {}, style: {}, classes: [], children: [],
    parent: null, visible: true, locked: false, ...p,
  } as NodeModel
}

function doc(): DocumentModel {
  const d = emptyDocument('d', 'My Dashboard')
  d.tokens = { primary: '#3366ff', 'space-lg': '24px' }
  d.fonts = {
    Inter: { family: 'Inter', weights: [400, 700], source: 'google' },
    'System Mono': { family: 'System Mono', weights: [400], source: 'system' },
  }
  d.nodes = {
    root: node({ id: 'root', name: 'Root', tag: 'div', classes: ['flex', 'gap-4'], children: ['t'] }),
    t: node({ id: 't', name: 'Title', tag: 'h1', parent: 'root', text: 'Hi', style: { color: 'var(--primary)' } }),
  }
  d.pages[0].children = ['root']
  return d
}

describe('standalone HTML export (#11)', () => {
  it('wraps the fragment in a full document with the doc name as title', () => {
    const html = exportHtml(doc(), 'root', { standalone: true })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<head>')
    expect(html).toContain('<body>')
    expect(html).toContain('<title>My Dashboard</title>')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('emits a Google Fonts <link> per google font, skipping system fonts', () => {
    const html = exportHtml(doc(), 'root', { standalone: true })
    expect(html).toContain('fonts.googleapis.com/css2?family=Inter:wght@400;700')
    expect(html).not.toContain('System+Mono')
    expect(html).not.toContain('System Mono')
  })

  it('emits a :root token block from doc.tokens', () => {
    const html = exportHtml(doc(), 'root', { standalone: true })
    expect(html).toMatch(/:root \{[\s\S]*--primary: #3366ff;[\s\S]*--space-lg: 24px;[\s\S]*\}/)
  })

  it('includes the Tailwind browser runtime so utility classes compile', () => {
    const html = exportHtml(doc(), 'root', { standalone: true })
    expect(html).toContain('@tailwindcss/browser')
    expect(html).toContain('<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>')
    // The body still carries the utility classes the runtime will compile.
    expect(html).toContain('class="flex gap-4"')
  })

  it('default (non-standalone) export stays a bare fragment', () => {
    const html = exportHtml(doc(), 'root')
    expect(html).not.toContain('<!doctype')
    expect(html).not.toContain('<head>')
    expect(html.startsWith('<div')).toBe(true)
  })

  it('parses into a single document element with the expected structure', () => {
    const html = exportHtml(doc(), 'root', { standalone: true })
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('title')?.textContent).toBe('My Dashboard')
    expect(parsed.querySelectorAll('link[rel="stylesheet"]').length).toBe(1)
    expect(parsed.querySelector('body > div')?.className).toBe('flex gap-4')
  })
})
