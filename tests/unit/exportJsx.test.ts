import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { emptyDocument } from '#/editor/model/doc'
import { exportJsx } from '#/editor/compiler/export'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

function node(p: Partial<NodeModel> & Pick<NodeModel, 'id' | 'tag'>): NodeModel {
  return {
    name: p.id, attrs: {}, style: {}, classes: [], children: [],
    parent: null, visible: true, locked: false, ...p,
  } as NodeModel
}

/** Transpile JSX as the React preset does — throws on a syntax error. */
function transpiles(jsx: string): boolean {
  const out = ts.transpileModule(`import React from 'react'\n${jsx}`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  })
  // transpileModule reports only syntactic diagnostics; any means it won't compile.
  return (out.diagnostics ?? []).length === 0
}

function svgDoc(): DocumentModel {
  const doc = emptyDocument('d', 'T')
  doc.nodes = {
    icon: node({
      id: 'icon', name: 'Ring', tag: 'svg',
      attrs: { viewBox: '0 0 24 24', width: '24', 'aria-hidden': 'true' },
      children: ['p'],
    }),
    p: node({
      id: 'p', name: 'Stroke', tag: 'path', parent: 'icon',
      attrs: {
        d: 'M0 0L4 4', 'stroke-width': '2', 'stroke-linecap': 'round',
        'stroke-linejoin': 'round', 'fill-rule': 'evenodd', 'stop-color': '#fff',
      },
    }),
  }
  doc.pages[0].children = ['icon']
  return doc
}

describe('JSX export defects (#10)', () => {
  it('camelCases SVG presentation attributes', () => {
    const jsx = exportJsx(svgDoc(), 'icon')
    expect(jsx).toContain('strokeWidth="2"')
    expect(jsx).toContain('strokeLinecap="round"')
    expect(jsx).toContain('strokeLinejoin="round"')
    expect(jsx).toContain('fillRule="evenodd"')
    expect(jsx).toContain('stopColor="#fff"')
    // No kebab-case presentation attrs survive.
    expect(jsx).not.toMatch(/stroke-width=/)
    expect(jsx).not.toMatch(/stroke-linecap=/)
    expect(jsx).not.toMatch(/fill-rule=/)
  })

  it('keeps aria-*/data-* attribute names verbatim', () => {
    const jsx = exportJsx(svgDoc(), 'icon')
    expect(jsx).toContain('aria-hidden="true"')
  })

  it('strips data-cz-* by default, keeps them under ids:true', () => {
    const doc = svgDoc()
    expect(exportJsx(doc, 'icon')).not.toContain('data-cz-id')
    expect(exportJsx(doc, 'icon')).not.toContain('data-cz-name')
    const withIds = exportJsx(doc, 'icon', { ids: true })
    expect(withIds).toContain('data-cz-id="icon"')
    expect(withIds).toContain('data-cz-name="Ring"')
  })

  it('compiles under the React JSX transform (no kebab attrs)', () => {
    expect(transpiles(svgDoc() && exportJsx(svgDoc(), 'icon'))).toBe(true)
  })
})

function componentDoc(): DocumentModel {
  const doc = emptyDocument('d', 'Dashboard')
  doc.nodes = {
    cardRoot: node({
      id: 'cardRoot', name: 'StatCard', tag: 'div', isComponentRoot: true,
      style: { position: 'absolute', left: '10px', top: '20px', width: '200px' },
      children: ['cardTitle'],
    }),
    cardTitle: node({ id: 'cardTitle', name: 'Label', tag: 'span', parent: 'cardRoot', text: 'Revenue' }),
    page: node({ id: 'page', name: 'Dashboard', tag: 'div', children: ['i1', 'i2', 'i3', 'i4'] }),
    i1: node({ id: 'i1', name: 'StatCard', tag: 'div', componentId: 'cmp', parent: 'page', style: { position: 'absolute', left: '0px', top: '0px' }, overrides: { cardTitle: { text: 'Users' } } }),
    i2: node({ id: 'i2', name: 'StatCard', tag: 'div', componentId: 'cmp', parent: 'page', style: { position: 'absolute', left: '210px', top: '0px' }, overrides: { cardTitle: { text: 'Sales' } } }),
    i3: node({ id: 'i3', name: 'StatCard', tag: 'div', componentId: 'cmp', parent: 'page', style: { position: 'absolute', left: '0px', top: '120px' }, overrides: { cardTitle: { text: 'Churn' } } }),
    i4: node({ id: 'i4', name: 'StatCard', tag: 'div', componentId: 'cmp', parent: 'page', style: { position: 'absolute', left: '210px', top: '120px' } }),
  }
  doc.components = { cmp: { id: 'cmp', name: 'StatCard', rootId: 'cardRoot' } }
  doc.pages[0].children = ['page']
  return doc
}

describe('JSX component emission (#10c)', () => {
  it('emits one component function plus the root, instances as elements', () => {
    const jsx = exportJsx(componentDoc(), 'page')
    // Exactly one StatCard definition (not duplicated 4x); it consumes props.
    expect(jsx.match(/function StatCard\(props\)/g)?.length).toBe(1)
    expect(jsx).toContain('export function Dashboard()')
    // Four instances render as <StatCard .../> elements.
    expect(jsx.match(/<StatCard\b/g)?.length).toBe(4)
    // The card markup (its span) appears once, inside the function.
    expect(jsx.match(/<span/g)?.length).toBe(1)
  })

  it('surfaces per-instance text overrides as props the component consumes', () => {
    const jsx = exportJsx(componentDoc(), 'page')
    expect(jsx).toContain('label="Users"')
    expect(jsx).toContain('label="Sales"')
    expect(jsx).toContain('label="Churn"')
    // The function body actually reads the prop, defaulting to the definition.
    expect(jsx).toContain("{props.label ?? 'Revenue'}")
    // An instance with no override passes no label prop (falls back to default).
    expect(jsx).toMatch(/<StatCard style=\{\{ left: '210px', top: '120px' \}\} \/>/)
  })

  it('rides per-instance placement as an inline style prop on the element', () => {
    const jsx = exportJsx(componentDoc(), 'page')
    expect(jsx).toMatch(/<StatCard style=\{\{[^}]*left: '210px'/)
    // The component body keeps its non-placement style (width), not left/top.
    expect(jsx).toMatch(/function StatCard[\s\S]*width: '200px'/)
    expect(jsx).not.toMatch(/function StatCard[\s\S]*left: '10px'/)
  })

  it('the component-bearing document export compiles', () => {
    expect(transpiles(exportJsx(componentDoc(), 'page'))).toBe(true)
  })
})
