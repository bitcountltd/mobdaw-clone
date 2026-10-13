// The bottom dock: a bar with the tabs (clip, devices), what the open tab shows (the clip or the track, in its colour)
// and that tab's tools; under it the tab's panel. Drag the top edge to resize; double-click it, the chevron or D
// collapses it. Its open / tab / height live in the Studio's UI state (remembered on this device), but each session
// starts with the dock shut: it opens the first time a clip is opened or a track is focused.
import { MASTER_TRACK, getTracks, trackColor } from '@mobdaw/shared'
import { h } from '../../dom'
import { iconButton, segmented } from '../../theme/controls'
import { icon } from '../../theme/icons'
import { kindOf } from '../arrange/tracks'
import type { DockTab, Studio } from '../studio'
import { mountClipEditor, type PaneTitle } from './clipEditor'
import { mountRack } from './rack'
import './dock.css'

const MIN_H = 140
const DEFAULT_H = 300
/** The arrangement keeps at least this much of the window (top bar, ruler and a couple of tracks). */
const KEEP_ABOVE = 260
/** The tallest the dock may be in a window `winH` high. */
export const dockMax = (winH: number) => Math.max(MIN_H, winH - KEEP_ABOVE)

export function mountDock(st: Studio) {
  const clip = mountClipEditor(st)
  const rack = mountRack(st)
  const tabs = segmented<DockTab>([
    { value: 'clip', icon: 'piano', label: 'clip', title: 'the open clip' },
    { value: 'devices', icon: 'effect', label: 'devices', title: 'the focused track\'s devices' },
  ], st.ui.dock.tab, (tab) => (touched = true, st.setUi({ dock: { ...st.ui.dock, open: true, tab } })))
  tabs.el.classList.add('dock-tabs')
  const chip = h('i', { className: 'dock-chip' })
  const name = h('strong', { className: 'dock-name' })
  const sub = h('span', { className: 'dock-sub' })
  const what = h('div', { className: 'dock-what' }, chip, name, sub)
  const clipTools = h('div', { className: 'dock-tool' }, clip.tools)
  const rackTools = h('div', { className: 'dock-tool' }, rack.tools)
  const tools = h('div', { className: 'dock-tools' }, clipTools, rackTools)
  const toggleB = iconButton('chevron-down', 'collapse the dock (d)', () => (touched = true, st.setUi({ dock: { ...st.ui.dock, open: !st.ui.dock.open } })), 'sm dock-toggle')
  const edge = h('div', { className: 'dock-edge', title: 'drag to resize; double-click to collapse (d)' })
  const panes = h('div', { className: 'dock-body' }, clip.el, rack.el)
  const bar = h('div', { className: 'dock-bar' }, tabs.el, what, tools, toggleB)
  const el = h('section', { className: 'dock' }, edge, bar, panes)

  // A fresh session starts shut (an empty dock on first load is just in the way) until there is something to show.
  let touched = false
  if (!(st.ui.dock.height >= MIN_H)) st.ui.dock.height = DEFAULT_H
  st.ui.dock.height = Math.min(st.ui.dock.height, dockMax(innerHeight))
  st.ui.dock = { ...st.ui.dock, open: false }
  const offFirst = st.on('ui', (p) => {
    if (touched) return
    if ('dock' in p && p.dock?.open) return void (touched = true) // opened by a shortcut or a header click
    if ((('editing' in p) && p.editing) || (('focusTrack' in p) && p.focusTrack)) {
      touched = true
      st.setUi({ dock: { ...st.ui.dock, open: true, tab: ('editing' in p && p.editing) || st.ui.editing ? 'clip' : 'devices' } })
    }
  })

  edge.ondblclick = () => (touched = true, st.setUi({ dock: { ...st.ui.dock, open: !st.ui.dock.open } }))
  edge.onpointerdown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    touched = true
    const y0 = e.clientY
    const h0 = st.ui.dock.open ? st.ui.dock.height : 0
    const max = () => dockMax(innerHeight)
    el.classList.add('resizing')
    const move = (m: PointerEvent) => {
      const want = h0 + (y0 - m.clientY)
      if (want < MIN_H / 2) return st.ui.dock.open && st.setUi({ dock: { ...st.ui.dock, open: false } })
      st.setUi({ dock: { ...st.ui.dock, open: true, height: Math.round(Math.min(max(), Math.max(MIN_H, want))) } })
    }
    const up = () => {
      el.classList.remove('resizing')
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      window.dispatchEvent(new Event('resize')) // the arrangement's height changed
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  // after the open / close animation the arrangement re-measures itself
  panes.addEventListener('transitionend', (e) => { if (e.target === panes && e.propertyName === 'height') window.dispatchEvent(new Event('resize')) })

  function title(): PaneTitle | null {
    if (st.ui.dock.tab === 'clip') return clip.title()
    const id = st.ui.focusTrack
    if (id === MASTER_TRACK) return { name: 'master', sub: 'effects on the whole mix', color: 'var(--fg)' }
    const tracks = getTracks(st.doc)
    const i = tracks.findIndex((t) => t.id === id)
    if (i < 0) return null
    const t = tracks[i]
    return { name: t.name, sub: kindOf(st.doc, t).label, color: trackColor(t, i) }
  }
  function head() {
    const t = title()
    what.hidden = !t
    if (!t) return
    if (name.textContent !== t.name) name.textContent = t.name
    if (sub.textContent !== t.sub) sub.textContent = t.sub
    what.style.setProperty('--c', t.color ?? 'var(--dim)')
  }

  function layout() {
    const { open, tab, height } = st.ui.dock
    el.classList.toggle('open', open)
    panes.style.height = open ? `${height}px` : '0px'
    panes.inert = !open
    tabs.set(tab)
    clip.el.hidden = tab !== 'clip'
    rack.el.hidden = tab !== 'devices'
    clipTools.hidden = tab !== 'clip'
    rackTools.hidden = tab !== 'devices'
    toggleB.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right', 16))
    toggleB.classList.toggle('shut', !open)
    toggleB.title = open ? 'collapse the dock (d)' : 'open the dock (d)'
    toggleB.setAttribute('aria-label', toggleB.title)
    if (open && tab === 'clip') clip.draw() // (it may have drawn while hidden, unable to measure itself)
    head()
  }

  // a smaller window: the dock gives back room so the tracks stay in view
  const onResize = () => {
    const m = dockMax(innerHeight)
    if (st.ui.dock.height > m) st.setUi({ dock: { ...st.ui.dock, height: m } })
  }
  addEventListener('resize', onResize)
  const offs = [
    offFirst,
    () => removeEventListener('resize', onResize),
    st.on('ui', (p) => {
      if ('dock' in p) layout()
      else if ('focusTrack' in p || 'editing' in p) head()
    }),
    st.on('doc', head),
  ]
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
