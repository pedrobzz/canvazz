import { describe, expect, it } from 'vitest'
import { applyOps, emptyDocument } from '#/editor/model/doc'
import { exportHtml, exportJsx, styleToReact } from '#/editor/compiler/export'
import { parseHtml, parseStyleAttr, sanitizeStyle } from '#/editor/compiler/parse'
import type { DocumentModel } from '#/editor/model/types'

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

describe('parseStyleAttr', () => {
  it('splits declarations and respects url() and quotes', () => {
    const decls = parseStyleAttr(
      `background-image: url("data:image/png;base64,abc;def"); color: red; font-family: 'He;l', sans-serif`,
    )
    expect(decls).toEqual([
      ['background-image', 'url("data:image/png;base64,abc;def")'],
      ['color', 'red'],
      ['font-family', "'He;l', sans-serif"],
    ])
  })
})

describe('sanitizer', () => {
  it('strips scripts, handlers, javascript: URLs, iframes', () => {
    const { doc, rootIds, dropped } = intoDoc(`
      <div onclick="alert(1)" style="width: 100px">
        <script>alert(1)</script>
        <iframe src="https://evil.example"></iframe>
        <a href="javascript:alert(1)">link</a>
        <img src="https://ok.example/a.png" onerror="alert(1)" />
      </div>
    `)
    const html = exportHtml(doc, rootIds[0])
    expect(html).not.toContain('script')
    expect(html).not.toContain('iframe')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('https://ok.example/a.png')
    expect(dropped).toContain('tag:script')
    expect(dropped).toContain('tag:iframe')
    expect(dropped).toContain('attr:onclick')
    expect(dropped).toContain('url:href')
  })

  it('rejects unsupported and dangerous CSS, keeps allowed CSS', () => {
    const style = sanitizeStyle(
      `width: 10px; behavior: url(#default#time2); background: url(javascript:alert(1)); ` +
        `background-image: url("https://ok.example/x.png"); -weird-prop: 1; color: red`,
    )
    expect(style).toEqual({
      width: '10px',
      'background-image': 'url("https://ok.example/x.png")',
      color: 'red',
    })
  })

  it('keeps tailwind classes but drops dangerous tokens', () => {
    const { doc, rootIds } = intoDoc(`<div class="flex items-center bg-[url(javascript:x)] gap-2">hi</div>`)
    const node = doc.nodes[rootIds[0]]
    expect(node.classes).toEqual(['flex', 'items-center', 'gap-2'])
  })
})

describe('round trip', () => {
  it('HTML -> model -> HTML preserves ids, names, styles, classes, text', () => {
    const input = `<div data-cz-id="root-1" data-cz-name="Card" class="flex flex-col" style="position: absolute; left: 10px; top: 20px; width: 300px; gap: 8px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.2)">
  <h2 data-cz-id="title-1" data-cz-name="Title" style="font-size: 18px">Hello</h2>
  <p data-cz-id="body-1" data-cz-name="Body">World</p>
  <img data-cz-id="img-1" data-cz-name="Photo" src="https://ok.example/a.png" alt="photo" />
</div>`
    const first = intoDoc(input)
    const html = exportHtml(first.doc, 'root-1')

    // Re-import the exported HTML: identical model.
    const second = intoDoc(html)
    expect(second.rootIds).toEqual(['root-1'])
    const a = first.doc.nodes
    const b = second.doc.nodes
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
    for (const id of Object.keys(a)) {
      expect(b[id].tag).toBe(a[id].tag)
      expect(b[id].name).toBe(a[id].name)
      expect(b[id].style).toEqual(a[id].style)
      expect(b[id].classes).toEqual(a[id].classes)
      expect(b[id].text).toBe(a[id].text)
      expect(b[id].children).toEqual(a[id].children)
    }
    expect(second.dropped).toHaveLength(0)
  })

  it('renders exported HTML into DOM identically (model -> DOM -> model)', () => {
    const input = `<div data-cz-id="r" data-cz-name="Row" style="display: flex; gap: 4px"><span data-cz-id="s1" data-cz-name="A">A</span><span data-cz-id="s2" data-cz-name="B">B</span></div>`
    const { doc } = intoDoc(input)
    const html = exportHtml(doc, 'r')
    const el = document.createElement('div')
    el.innerHTML = html
    const root = el.firstElementChild as HTMLElement
    expect(root.tagName).toBe('DIV')
    expect(root.style.display).toBe('flex')
    expect(root.style.gap).toBe('4px')
    expect(root.children).toHaveLength(2)
    expect(root.children[0].textContent).toBe('A')
    expect(root.getAttribute('data-cz-id')).toBe('r')
  })

  it('normalizes mixed text/element content into spans without losing text', () => {
    const { doc, rootIds } = intoDoc(`<p data-cz-id="p1">Hello <strong data-cz-id="st">bold</strong> world</p>`)
    const p = doc.nodes[rootIds[0]]
    expect(p.text).toBeUndefined()
    expect(p.children).toHaveLength(3)
    const texts = p.children.map((c) => doc.nodes[c].text)
    expect(texts).toEqual(['Hello ', 'bold', ' world'])
    const html = exportHtml(doc, 'p1')
    expect(html).toContain('Hello')
    expect(html).toContain('bold')
    expect(html).toContain('world')
  })

  it('exports JSX with className and camelCase styles', () => {
    const { doc, rootIds } = intoDoc(
      `<div data-cz-name="Card" class="flex" style="background-color: red; border-radius: 8px">hi</div>`,
    )
    const jsx = exportJsx(doc, rootIds[0])
    expect(jsx).toContain('export function Card()')
    expect(jsx).toContain('className="flex"')
    expect(jsx).toContain("backgroundColor: 'red'")
    expect(jsx).toContain("borderRadius: '8px'")
  })

  it('styleToReact handles custom props and vendor prefixes', () => {
    expect(styleToReact({ '--x': '1', '-webkit-line-clamp': '2', 'border-top-width': '1px' })).toEqual({
      '--x': '1',
      WebkitLineClamp: '2',
      borderTopWidth: '1px',
    })
  })
})
