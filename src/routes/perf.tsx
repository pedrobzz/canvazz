import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CanvasRoot } from '#/editor/canvas/CanvasRoot'
import { emptyDocument } from '#/editor/model/doc'
import { editorStore } from '#/editor/store/editorStore'
import { Inspector } from '#/editor/ui/Inspector'
import { LeftPanel } from '#/editor/ui/LeftPanel'
import { Toolbar } from '#/editor/ui/Toolbar'
import type { DocumentModel, NodeModel } from '#/editor/model/types'

/**
 * Performance harness: /perf?n=1000 renders an n-node document and records
 * mount time on window.__perfStats. Playwright drives pan/zoom/selection on
 * top and measures frame times.
 */

export const Route = createFileRoute('/perf')({
  ssr: false,
  validateSearch: (search): { n?: number } => ({
    n: search.n ? Number(search.n) : undefined,
  }),
  component: PerfPage,
})

const COLORS = ['#fca5a5', '#fdba74', '#fde047', '#86efac', '#93c5fd', '#d8b4fe']

export function generatePerfDoc(totalNodes: number): DocumentModel {
  const doc = emptyDocument('perf', `Perf ${totalNodes}`)
  const perArtboard = 250
  const artboardCount = Math.ceil(totalNodes / perArtboard)
  let made = 0
  for (let a = 0; a < artboardCount; a++) {
    const artboardId = `pa_${a}`
    const children: string[] = []
    const artboard: NodeModel = {
      id: artboardId, name: `Board ${a + 1}`, tag: 'div', attrs: {},
      style: {
        position: 'absolute', left: `${a * 560}px`, top: '0px',
        width: '520px', height: '760px', 'background-color': '#ffffff', overflow: 'hidden',
      },
      classes: [], children, parent: null, visible: true, locked: false, isArtboard: true,
    }
    doc.nodes[artboardId] = artboard
    doc.pages[0].children.push(artboardId)
    const count = Math.min(perArtboard, totalNodes - made)
    for (let i = 0; i < count; i++) {
      const id = `pn_${a}_${i}`
      const col = i % 16
      const row = Math.floor(i / 16)
      const isText = i % 10 === 9
      doc.nodes[id] = {
        id, name: isText ? `Label ${i}` : `Box ${i}`, tag: isText ? 'p' : 'div', attrs: {},
        style: {
          position: 'absolute',
          left: `${12 + col * 31}px`,
          top: `${12 + row * 46}px`,
          width: '26px',
          height: '40px',
          ...(isText
            ? { 'font-size': '9px', margin: '0', color: '#334155' }
            : {
                'background-color': COLORS[i % COLORS.length],
                'border-radius': i % 3 === 0 ? '50%' : '4px',
                'box-shadow': i % 7 === 0 ? '0 1px 3px rgba(0,0,0,0.3)' : '',
              }),
        },
        classes: [], children: [], parent: artboardId, visible: true, locked: false,
        text: isText ? `n${i}` : undefined,
      }
      children.push(id)
      made++
    }
  }
  // Drop empty-string styles introduced above.
  for (const node of Object.values(doc.nodes)) {
    for (const [k, v] of Object.entries(node.style)) if (!v) delete node.style[k]
  }
  return doc
}
