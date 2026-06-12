import { emptyDocument } from './doc'
import { genId } from './ids'
import type { DocumentModel } from './types'

/** Starter content so a fresh document demonstrates the DOM-native canvas. */
export function seedDocument(): DocumentModel {
  const doc = emptyDocument(genId('doc'), 'Untitled')
  const ids = {
    artboard: 'artboard-1', card: 'card-1', title: 'title-1', body: 'body-1',
    button: 'button-1', buttonLabel: 'button-label-1', hero: 'hero-1',
  }
  doc.nodes = {
    [ids.artboard]: {
      id: ids.artboard, name: 'Home', tag: 'div', attrs: {},
      style: {
        position: 'absolute', left: '120px', top: '80px', width: '375px', height: '667px',
        'background-color': '#ffffff', overflow: 'hidden',
      },
      classes: [], children: [ids.hero, ids.card], parent: null,
      visible: true, locked: false, isArtboard: true,
    },
    [ids.hero]: {
      id: ids.hero, name: 'Hero', tag: 'div', attrs: {},
      style: {
        position: 'absolute', left: '0px', top: '0px', width: '375px', height: '220px',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      },
      classes: [], children: [], parent: ids.artboard, visible: true, locked: false,
    },
    [ids.card]: {
      id: ids.card, name: 'Card', tag: 'div', attrs: {},
      style: {
        position: 'absolute', left: '24px', top: '180px', width: '327px',
        display: 'flex', 'flex-direction': 'column', gap: '12px', padding: '20px',
        'background-color': '#ffffff', 'border-radius': '16px',
        'box-shadow': '0 8px 32px rgba(20, 24, 40, 0.16)',
      },
      classes: [], children: [ids.title, ids.body, ids.button], parent: ids.artboard,
      visible: true, locked: false,
    },
    [ids.title]: {
      id: ids.title, name: 'Title', tag: 'h2', attrs: {},
      style: { margin: '0', 'font-size': '20px', 'font-weight': '700', color: '#141828' },
      classes: [], children: [], parent: ids.card, visible: true, locked: false,
      text: 'Design with real DOM',
    },
    [ids.body]: {
      id: ids.body, name: 'Body', tag: 'p', attrs: {},
      style: { margin: '0', 'font-size': '14px', 'line-height': '1.5', color: '#5a6072' },
      classes: [], children: [], parent: ids.card, visible: true, locked: false,
      text: 'Every layer on this canvas is a live HTML element with CSS. What you design is what ships.',
    },
    [ids.button]: {
      id: ids.button, name: 'Button', tag: 'button', attrs: {},
      style: {
        display: 'flex', 'align-items': 'center', 'justify-content': 'center',
        padding: '10px 16px', 'background-color': '#4f8ef7', color: '#ffffff',
        'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', border: 'none',
      },
      classes: [], children: [ids.buttonLabel], parent: ids.card, visible: true, locked: false,
    },
    [ids.buttonLabel]: {
      id: ids.buttonLabel, name: 'Label', tag: 'span', attrs: {},
      style: {}, classes: [], children: [], parent: ids.button, visible: true, locked: false,
      text: 'Get started',
    },
  }
  doc.pages[0].children = [ids.artboard]
  return doc
}
