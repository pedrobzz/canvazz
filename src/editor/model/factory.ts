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
