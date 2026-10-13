// The status bar (docs/redesign.md §3): on the left, a hint for what is under the pointer (any element with a
// `data-hint` attribute, set by any view) or else the studio's status text; on the right, zoom, cpu, the sample rate and
// where the project is saved.
import { h } from '../dom'
import { iconButton, tooltip } from '../theme/controls'
import { ZOOM_FIT, ZOOM_MAX, ZOOM_MIN } from './arrange/arrange'
import type { Studio } from './studio'
import './statusbar.css'

/** A fresh status message wins over hover hints for this long (ms). */
const FRESH = 4000

export function mountStatusbar(st: Studio, host: () => HTMLElement | null) {
  const { s, readOnly } = st
  const text = h('span', { className: 'status-text' })
  const zoom = (f: number) => st.setUi({ pps: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.ui.pps * f)) })
  const zOut = iconButton('zoom-out', 'zoom out', () => zoom(1 / 1.5), 'sm')
  const zFit = h('button', { className: 'sb-fit', type: 'button', onclick: () => dispatchEvent(new Event(ZOOM_FIT)) }, 'fit')
  const zIn = iconButton('zoom-in', 'zoom in', () => zoom(1.5), 'sm')
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'ctrl+'
  tooltip(zOut, 'zoom out', `${mod}-`)
  tooltip(zFit, 'zoom to fit the song', 'Z')
  tooltip(zIn, 'zoom in', `${mod}+`)
  const cpu = h('span', { className: 'sb-cpu', 'data-hint': 'audio engine load: share of the real-time budget used by DSP (peak in the last half second)' }, 'cpu –')
  const rate = h('span', { className: 'sb-rate', 'data-hint': 'the project sample rate' })
  const where = readOnly
    ? h('span', { className: 'sb-where' }, 'view only')
    : s.local ? h('span', { className: 'sb-where', 'data-hint': 'saved in this browser, on this device; export a .mobdaw file from the home page to move it' }, 'saved on this device') : null
  const el = h('footer', { className: 'studio-status' },
    text, h('span', { className: 'grow' }),
    h('span', { className: 'sb-zoom' }, zOut, zFit, zIn), cpu, rate, where)

  let hint = ''
  let statusAt = 0
  const draw = () => {
    const fresh = st.statusText && performance.now() - statusAt < FRESH
    const t = fresh ? st.statusText : hint || st.statusText
    if (text.textContent !== t) text.textContent = t
    text.classList.toggle('is-hint', !fresh && !!hint)
  }
  let freshTimer = 0
  const onStatus = () => {
    statusAt = performance.now()
    clearTimeout(freshTimer)
    freshTimer = window.setTimeout(draw, FRESH + 20)
    draw()
  }
  const onOver = (e: PointerEvent) => {
    const root = host()
    const t = e.target as Element | null
    const at = t && root?.contains(t) ? t.closest<HTMLElement>('[data-hint]') : null
    const next = at && root!.contains(at) ? at.dataset.hint ?? '' : ''
    if (next !== hint) (hint = next), draw()
  }
  const onLeave = () => { if (hint) (hint = ''), draw() }
  document.addEventListener('pointerover', onOver)
  document.documentElement.addEventListener('pointerleave', onLeave)

  const drawRate = () => {
    const k = st.rate / 1000
    rate.textContent = `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`
  }
  const offs = [
    st.on('status', onStatus),
    st.on('cpu', (m) => {
      const t = `cpu ${Math.round(m.load * 100)}%`
      if (cpu.textContent !== t) cpu.textContent = t
      cpu.classList.toggle('hot', m.peak >= 0.8)
    }),
    st.on('transport', drawRate),
    st.on('doc', drawRate),
  ]
  drawRate()
  draw()
  return {
    el,
    destroy() {
      offs.forEach((f) => f())
      clearTimeout(freshTimer)
      document.removeEventListener('pointerover', onOver)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    },
  }
}
