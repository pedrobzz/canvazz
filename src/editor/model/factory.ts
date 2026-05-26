import { genId } from './ids'
import type { NodeModel } from './types'

/**
 * Shape factories. Every "shape" is a plain HTML element styled with CSS —
 * there is no separate vector renderer. Positions are inline left/top because
 * design-surface children default to absolute positioning until a parent
 * frame opts into flex auto-layout.
 */

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

function base(partial: Partial<NodeModel> & Pick<NodeModel, 'name' | 'tag'>): NodeModel {
  return {
    id: genId(),
    attrs: {},
    style: {},
    classes: [],
    children: [],
    parent: null,
    visible: true,
    locked: false,
    ...partial,
  }
}

export function absoluteBox(box: Box): Record<string, string> {
  return {
    position: 'absolute',
    left: `${round(box.x)}px`,
    top: `${round(box.y)}px`,
    width: `${round(box.width)}px`,
    height: `${round(box.height)}px`,
  }
}

const round = (n: number) => Math.round(n * 100) / 100

export function createArtboard(name: string, box: Box): NodeModel {
  return base({
    name,
    tag: 'div',
    isArtboard: true,
    style: {
      ...absoluteBox(box),
      'background-color': '#ffffff',
      overflow: 'hidden',
    },
  })
}

export function createFrame(name: string, box: Box): NodeModel {
  return base({
    name,
    tag: 'div',
    style: { ...absoluteBox(box), 'background-color': '#f5f5f5', overflow: 'hidden' },
  })
}

export function createRectangle(box: Box): NodeModel {
  return base({
    name: 'Rectangle',
    tag: 'div',
    style: { ...absoluteBox(box), 'background-color': '#d9d9d9' },
  })
}

export function createEllipse(box: Box): NodeModel {
  return base({
    name: 'Ellipse',
    tag: 'div',
    style: { ...absoluteBox(box), 'background-color': '#d9d9d9', 'border-radius': '9999px' },
  })
}

/** A line is a thin div: length = width, stroke = height, angle = rotate. */
export function createLine(x: number, y: number, length: number, angleDeg: number): NodeModel {
  return base({
    name: 'Line',
    tag: 'div',
    style: {
      ...absoluteBox({ x, y, width: length, height: 2 }),
      'background-color': '#000000',
      rotate: `${round(angleDeg)}deg`,
      'transform-origin': '0% 50%',
    },
  })
}

export function polygonClipPath(sides: number): string {
  const pts: string[] = []
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2
    pts.push(`${round(50 + 50 * Math.cos(angle))}% ${round(50 + 50 * Math.sin(angle))}%`)
  }
  return `polygon(${pts.join(', ')})`
}

export function starClipPath(points = 5, innerRatio = 0.4): string {
  const pts: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? 50 : 50 * innerRatio
    const angle = (Math.PI * i) / points - Math.PI / 2
    pts.push(`${round(50 + radius * Math.cos(angle))}% ${round(50 + radius * Math.sin(angle))}%`)
  }
  return `polygon(${pts.join(', ')})`
}

export function createPolygon(box: Box, sides = 3): NodeModel {
  return base({
    name: 'Polygon',
    tag: 'div',
    style: { ...absoluteBox(box), 'background-color': '#d9d9d9', 'clip-path': polygonClipPath(sides) },
  })
}

export function createStar(box: Box): NodeModel {
  return base({
    name: 'Star',
    tag: 'div',
    style: { ...absoluteBox(box), 'background-color': '#d9d9d9', 'clip-path': starClipPath() },
  })
}
