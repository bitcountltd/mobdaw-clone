// The mixer view (studio.ui.view === 'mix'): a channel strip per track in track order, then the master on the right.
// A strip is the track's colour cap, its inserts (click: show the track's devices in the dock), a pan knob, the gain
// fader beside a stereo meter, mute / solo / arm, and the track's name on a label strip in its colour. The click track
// gets a narrow strip. The master strip has the master chain, a tall meter with peak hold and the peak readout.
import { DEVICES, MASTER_TRACK, getDevices, getTracks, isDrum, trackColor, updateTrack, type Device, type Track } from '@mobdaw/shared'
import { h } from '../../dom'
import { fader, knob, meter, toggle, type Fader, type Knob, type Meter, type Toggle } from '../../theme/controls'
import { icon, type IconName } from '../../theme/icons'
import { fmtDb } from '../../ui/slider'
import { applyDrop, canDrop, hasPayload, readDragPayload } from '../drops'
import type { Studio } from '../studio'
import './mixer.css'

const SLOTS = 5 // insert rows on a strip (they line up across the strips)
export const fmtPan = (v: number) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)
const KIND_ICON: Record<string, IconName> = { audio: 'wave', midi: 'piano', soundscape: 'loop' }

type Strip = {
  id: string; el: HTMLElement; name: HTMLElement; inserts: HTMLElement; pan: Knob; panOut: HTMLElement; gain: Fader; meter: Meter
  mute: Toggle; solo: Toggle; arm: Toggle | null; kind: HTMLElement; click: boolean
}

/** The peak readout: the loudest level since the last reset, as dBFS text. */
export const peakText = (g: number) => (g <= 1e-5 ? '-∞' : (20 * Math.log10(g) > 0 ? '+' : '') + (20 * Math.log10(g)).toFixed(1))

export function mountMixer(st: Studio) {
  const { doc, undo, readOnly } = st
  const strips = new Map<string, Strip>()
  const row = h('div', { className: 'mx-strips' })
  const empty = h('div', { className: 'mx-empty' }, 'No tracks yet. Add one in the arrangement (or drop a sound here from the browser).')

  // --- the master strip
  const mMeter = meter({ stereo: true })
  const peakL = h('span', {}, '-∞'), peakR = h('span', {}, '-∞')
  let peak = [0, 0]
  const peaks = h('button', { className: 'mx-peaks', title: 'peak level since the last reset (click to reset)' }, peakL, peakR)
  peaks.onclick = () => { peak = [0, 0]; showPeaks(); mMeter.reset() }
  const showPeaks = () => {
    peakL.textContent = peakText(peak[0])
    peakR.textContent = peakText(peak[1])
    peaks.classList.toggle('hot', Math.max(...peak) >= 1)
  }
  const mInserts = h('div', { className: 'mx-inserts' })
  const scale = h('div', { className: 'mx-scale' }, ...[6, 0, -6, -12, -24, -48].map((db) => {
    const t = h('span', {}, db > 0 ? `+${db}` : String(db))
    t.style.setProperty('--p', String(((Math.max(-60, db) + 60) / 66) ** 1.35))
    return t
  }))
  const master = h('div', { className: 'mx-strip master' },
    h('div', { className: 'mx-cap' }),
    h('div', { className: 'mx-section' }, h('div', { className: 'mx-label' }, 'master chain'), mInserts),
    h('div', { className: 'mx-meter-big' }, scale, mMeter.el),
    peaks,
    h('button', { className: 'mx-name', title: 'show the master\'s effects in the dock', onclick: () => focus(MASTER_TRACK) }, 'master'))

  const el = h('div', { className: 'mixer' }, h('div', { className: 'mx-scroll' }, row, empty, master))

  function focus(id: string) {
    st.setUi({ focusTrack: id, dock: { ...st.ui.dock, open: true, tab: 'devices' } })
  }

  /** The chain as slots: a track's drums as one entry, then its devices; as many as fit, then "n more". */
  function insertList(box: HTMLElement, list: Device[], trackId: string) {
    const drums = list.filter(isDrum)
    const entries: { label: string; off: boolean; inst: boolean }[] = [
      ...(drums.length ? [{ label: drums.length === 1 ? drums[0].name ?? 'drum' : `${drums.length} drums`, off: drums.every((d) => d.bypass), inst: true }] : []),
      ...list.filter((d) => !isDrum(d)).map((d) => ({ label: d.name ?? DEVICES[d.type]?.name ?? 'device', off: !!d.bypass, inst: !!DEVICES[d.type]?.instrument })),
    ]
    const room = SLOTS - (readOnly ? 0 : 1)
    const shown = entries.length > room ? entries.slice(0, room - 1) : entries
    const items = shown.map((e) => {
      const b = h('button', { className: `mx-insert${e.off ? ' off' : ''}${e.inst ? ' inst' : ''}`, title: `${e.label}: show in the dock` }, h('i', {}), h('span', {}, e.label))
      b.onclick = () => focus(trackId)
      return b
    })
    if (shown.length < entries.length) items.push(h('button', { className: 'mx-insert more', title: 'show them all in the dock', onclick: () => focus(trackId) }, h('span', {}, `${entries.length - shown.length} more`)))
    if (!readOnly) items.push(h('button', { className: 'mx-insert add', title: 'add an instrument or effect (in the dock)', onclick: () => focus(trackId) }, icon('plus', 12), h('span', {}, entries.length ? '' : 'add')))
    box.replaceChildren(...items)
  }

  function make(t: Track): Strip {
    const id = t.id
    const click = t.role === 'click'
    const name = h('button', { className: 'mx-name', title: 'show this track\'s devices in the dock', onclick: () => focus(id) })
    const kind = h('span', { className: 'mx-kind' })
    const inserts = h('div', { className: 'mx-inserts' })
    const panOut = h('span', { className: 'mx-pan-out' })
    const grab = () => undo.stopCapturing()
    const pan = knob({ value: t.pan ?? 0, min: -1, max: 1, def: 0, bipolar: true, size: click ? 26 : 30, title: 'pan (double-click: centre)', format: fmtPan, disabled: readOnly,
      onInput: (v) => { updateTrack(doc, id, { pan: Math.abs(v) < 0.02 ? 0 : v }); panOut.textContent = fmtPan(v) }, onChange: grab })
    const gain = fader({ value: t.gain, scale: !click, title: 'gain (double-click: 0 dB)', disabled: readOnly,
      onInput: (g) => updateTrack(doc, id, { gain: g }), onChange: grab })
    gain.el.addEventListener('pointerdown', grab, true)
    pan.el.addEventListener('pointerdown', grab, true)
    const m = meter({ stereo: true })
    const mute = toggle('m', { title: 'mute', onChange: (on) => updateTrack(doc, id, { muted: on }) })
    const solo = toggle('s', { title: 'solo', onChange: (on) => updateTrack(doc, id, { soloed: on }) })
    const arm = t.kind === 'audio' || t.kind === 'midi' ? toggle({ icon: 'arm' }, { title: 'arm for recording', tone: 'rec', onChange: () => void st.rec.arm(id) }) : null
    for (const b of [mute, solo, arm]) if (b) (b.el.disabled = readOnly), b.el.classList.add('mx-btn')
    solo.el.dataset.kind = 'solo'
    const el = h('div', { className: `mx-strip${click ? ' click' : ''}` },
      h('div', { className: 'mx-cap' }),
      h('div', { className: 'mx-top' }, kind),
      h('div', { className: 'mx-section' }, inserts),
      h('div', { className: 'mx-pan' }, pan.el, panOut),
      h('div', { className: 'mx-fader' }, gain.el, m.el),
      h('div', { className: 'mx-btns' }, mute.el, solo.el, arm?.el ?? null),
      name)
    el.dataset.track = id
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, .knob, .fader, .meter-el')) return
      st.focus(id)
    })
    const s: Strip = { id, el, name, inserts, pan, panOut, gain, meter: m, mute, solo, arm, kind, click }
    strips.set(id, s)
    return s
  }

  function draw() {
    const tracks = getTracks(doc)
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, s] of strips) if (!ids.has(id)) { s.meter.destroy(); s.el.remove(); strips.delete(id) }
    const devices = getDevices(doc)
    tracks.forEach((t, i) => {
      const s = strips.get(t.id) ?? make(t)
      if (row.children[i] !== s.el) row.insertBefore(s.el, row.children[i] ?? null)
      s.el.style.setProperty('--tc', trackColor(t, i))
      s.el.classList.toggle('focus', st.ui.focusTrack === t.id)
      s.el.classList.toggle('muted', t.muted)
      if (s.name.textContent !== t.name) (s.name.textContent = t.name), (s.name.title = `${t.name}: show its devices in the dock`)
      s.kind.replaceChildren(icon(t.role === 'click' ? 'metronome' : KIND_ICON[t.kind] ?? 'wave', 14), h('span', {}, String(i + 1)))
      const locked = readOnly || st.locks.has(t.id)
      s.gain.set(t.gain)
      s.gain.setDisabled(locked)
      s.pan.set(t.pan ?? 0)
      s.pan.setDisabled(locked)
      s.panOut.textContent = fmtPan(t.pan ?? 0)
      s.mute.set(t.muted)
      s.solo.set(t.soloed)
      s.arm?.set(st.ui.armedTrack === t.id)
      insertList(s.inserts, devices.filter((d) => d.trackId === t.id), t.id)
    })
    empty.hidden = tracks.length > 0
    master.classList.toggle('focus', st.ui.focusTrack === MASTER_TRACK)
    insertList(mInserts, devices.filter((d) => d.trackId === MASTER_TRACK), MASTER_TRACK)
  }

  function meters(m: { master: [number, number]; tracks: Map<string, [number, number]> }) {
    if (el.hidden) return
    for (const [id, s] of strips) {
      const v = m.tracks.get(id)
      if (v) s.meter.push(v[0], v[1])
    }
    mMeter.push(m.master[0], m.master[1])
    if (m.master[0] > peak[0] || m.master[1] > peak[1]) {
      peak = [Math.max(peak[0], m.master[0]), Math.max(peak[1], m.master[1])]
      showPeaks()
    }
  }

  // the browser's sounds and effects can be dropped on a strip (that track) or the master
  el.addEventListener('dragover', (e) => {
    const strip = (e.target as HTMLElement).closest<HTMLElement>('.mx-strip')
    if (!strip || !hasPayload(e) || readOnly) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    for (const s of el.querySelectorAll('.mx-strip.drop-on')) if (s !== strip) s.classList.remove('drop-on')
    strip.classList.add('drop-on')
  })
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget as Node)) el.querySelectorAll('.drop-on').forEach((s) => s.classList.remove('drop-on')) })
  el.addEventListener('drop', (e) => {
    const strip = (e.target as HTMLElement).closest<HTMLElement>('.mx-strip')
    el.querySelectorAll('.drop-on').forEach((s) => s.classList.remove('drop-on'))
    if (!strip) return
    e.preventDefault()
    const p = readDragPayload(e)
    if (!p) return
    const id = strip === master ? MASTER_TRACK : strip.dataset.track
    applyDrop(st, p, { trackId: id && canDrop(st, p, id) ? id : null })
  })

  function layout() {
    el.hidden = st.ui.view !== 'mix'
    if (!el.hidden) draw()
  }
  const offs = [
    st.on('doc', () => { if (!el.hidden) draw() }),
    st.on('ui', (p) => {
      if ('view' in p) layout()
      else if (!el.hidden && ('focusTrack' in p || 'armedTrack' in p)) draw()
    }),
    st.on('transport', () => { if (!el.hidden) draw() }),
    st.on('meters', meters),
  ]
  layout()
  return {
    el,
    destroy() {
      offs.forEach((f) => f())
      for (const s of strips.values()) s.meter.destroy()
      mMeter.destroy()
    },
  }
}
