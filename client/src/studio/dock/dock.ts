// The bottom dock: tabs (clip, devices), the open tab's panel, and resizing: drag the top edge, double-click it (or press
// D, or the chevron) to collapse. Its open / tab / height live in the Studio's UI state (remembered on this device).
import { h } from '../../dom'
import type { DockTab, Studio } from '../studio'
import { mountClipEditor } from './clipEditor'
import { mountRack } from './rack'
import './dock.css'

const MIN_H = 120
const TABS: [DockTab, string][] = [['clip', 'clip'], ['devices', 'devices']]

export function mountDock(st: Studio) {
  const clip = mountClipEditor(st)
  const rack = mountRack(st)
  const tabs = TABS.map(([tab, label]) => {
    const b = h('button', { className: 'dock-tab', onclick: () => st.setUi({ dock: { ...st.ui.dock, open: true, tab } }) }, label)
    b.dataset.tab = tab
    return b
  })
  const toggle = h('button', { className: 'dock-toggle', onclick: () => st.setUi({ dock: { ...st.ui.dock, open: !st.ui.dock.open } }) })
  const edge = h('div', { className: 'dock-edge', title: 'drag to resize; double-click to collapse (d)' })
  const panes = h('div', { className: 'dock-body' }, clip.el, rack.el)
  const el = h('section', { className: 'dock' }, edge, h('div', { className: 'dock-tabs' }, ...tabs, h('span', { className: 'grow' }), toggle), panes)

  edge.ondblclick = () => st.setUi({ dock: { ...st.ui.dock, open: !st.ui.dock.open } })
  edge.onpointerdown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y0 = e.clientY
    const h0 = st.ui.dock.open ? st.ui.dock.height : 0
    const max = () => Math.max(MIN_H, (el.parentElement?.clientHeight ?? innerHeight) - 160)
    const move = (m: PointerEvent) => {
      const want = h0 + (y0 - m.clientY)
      if (want < MIN_H / 2) return st.setUi({ dock: { ...st.ui.dock, open: false } })
      st.setUi({ dock: { ...st.ui.dock, open: true, height: Math.round(Math.min(max(), Math.max(MIN_H, want))) } })
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      window.dispatchEvent(new Event('resize')) // the arrangement's height changed
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  function layout() {
    const { open, tab, height } = st.ui.dock
    el.classList.toggle('open', open)
    panes.hidden = !open
    panes.style.height = `${height}px`
    for (const b of tabs) b.classList.toggle('on', open && b.dataset.tab === tab)
    clip.el.hidden = tab !== 'clip'
    rack.el.hidden = tab !== 'devices'
    toggle.textContent = open ? '▾' : '▴'
    toggle.title = open ? 'collapse the dock (d)' : 'open the dock (d)'
    if (open && tab === 'clip') clip.draw() // (it may have drawn while hidden, unable to measure itself)
  }

  const offs = [st.on('ui', (p) => { if ('dock' in p) layout() })]
  layout()
  return {
    el,
    destroy() {
      offs.forEach((f) => f())
      clip.destroy()
      rack.destroy()
    },
  }
}
