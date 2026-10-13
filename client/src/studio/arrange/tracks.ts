// Track headers (docs/redesign.md §2): the colour stripe, a grip to reorder, the kind icon, the name (double-click to
// rename), mute / solo / arm (+ input monitor while armed), a gain fader, a pan knob and a stereo meter. A click on the
// header's background focuses the track (the dock shows its devices); right-click opens the track menu; the bottom edge
// drags to resize the track. The lanes place each header at the left of its row; this module builds and updates them.
import {
  DEVICES, MASTER_TRACK, TRACK_COLORS, deleteTrack, getClips, getDevices, getTracks, isDrum, orderBetween, setTrackColor, trackColor, tracksMap,
  updateTrack, type Track,
} from '@mobdaw/shared'
import { h } from '../../dom'
import { confirmModal } from '../../theme/dialog'
import { fader, knob, meter, type Fader, type Knob, type Meter } from '../../theme/controls'
import { icon, type IconName } from '../../theme/icons'
import { dragPointer } from '../../ui/blocks'
import { closedBy, popover } from '../../ui/popover'
import { dragToReorder } from '../../ui/reorder'
import { duplicateTrack } from '../clipboard'
import type { Studio } from '../studio'
import { TRACK_H_DEFAULT, heightsFor } from './heights'

type Head = {
  el: HTMLElement; grip: HTMLElement; bound: boolean; name: HTMLElement; kind: HTMLElement; kindName: IconName | ''
  mute: HTMLButtonElement; solo: HTMLButtonElement; arm: HTMLButtonElement | null; monitor: HTMLButtonElement | null
  gain: Fader; pan: Knob; meter: Meter
}

const fmtPan = (v: number) => (Math.abs(v) < 0.005 ? 'centre' : `${Math.round(Math.abs(v) * 100)} ${v < 0 ? 'L' : 'R'}`)
const COMPACT_H = 56 // below this a header shows only its top row

export function mountTrackHeaders(st: Studio) {
  const { doc, readOnly } = st
  const heads = new Map<string, Head>()
  const heights = heightsFor(st)

  /** Ask before a press on a slider writes: the drag that follows is one undo step. */
  const grabs = (el: HTMLElement) => el.addEventListener('pointerdown', () => st.undo.stopCapturing(), true)
  const btn = (cls: string, title: string, content: string | Node, onclick: () => void) => {
    const b = h('button', { type: 'button', className: `th-btn ${cls}`, title, disabled: readOnly, onclick: (e: MouseEvent) => { e.stopPropagation(); onclick() } })
    b.append(content)
    return b
  }
  const cur = (id: string) => tracksMap(doc).get(id)

  function make(t: Track): Head {
    const id = t.id
    const name = h('span', { className: 'th-name', title: 'double-click to rename', ondblclick: (e: MouseEvent) => { e.stopPropagation(); if (!readOnly) rename(id) } })
    const kind = h('span', { className: 'th-kind' })
    const grip = h('span', { className: 'th-grip', title: 'drag to move the track' }, icon('grip', 14))
    const mute = btn('mute', 'mute (M)', 'm', () => updateTrack(doc, id, { muted: !cur(id)?.get('muted') }))
    const solo = btn('solo', 'solo (⇧S)', 's', () => updateTrack(doc, id, { soloed: !cur(id)?.get('soloed') }))
    const arm = t.kind === 'audio' || (t.kind === 'midi' && t.role !== 'click') ? btn('arm', 'arm for recording', icon('arm', 14), () => void st.rec.arm(id)) : null
    if (arm) arm.dataset.tone = 'rec'
    const monitor = arm && t.kind === 'audio' ? btn('monitor', 'monitor the input through this track\'s effects (use headphones)', icon('speaker', 14), () => st.rec.setMonitoring(!st.rec.monitoring)) : null
    if (monitor) monitor.hidden = true
    const gain = fader({ value: t.gain, orientation: 'horizontal', color: trackColor(t, 0), title: 'gain (double-click: 0 dB)', disabled: readOnly,
      onInput: (g) => updateTrack(doc, id, { gain: g }) })
    const pan = knob({ value: t.pan ?? 0, min: -1, max: 1, def: 0, bipolar: true, size: 22, title: 'pan (double-click: centre)', format: fmtPan,
      disabled: readOnly, onInput: (v) => updateTrack(doc, id, { pan: Math.abs(v) < 0.02 ? 0 : v }) })
    grabs(gain.el)
    grabs(pan.el)
    const m = meter({ orientation: 'vertical', stereo: true })
    m.el.classList.add('th-meter')
    const resize = h('div', { className: 'th-resize', title: 'drag to resize the track (double-click: default height)' })
    const el = h('div', { className: 'head track-head', 'data-track-head': id },
      h('div', { className: 'th-top' }, grip, kind, name, h('div', { className: 'th-btns' }, mute, solo, arm, monitor)),
      h('div', { className: 'th-bottom' }, gain.el, pan.el),
      m.el, resize)
    for (const c of [gain.el, pan.el]) c.addEventListener('click', (e) => e.stopPropagation())

    // A click on the header (not on its controls) focuses the track and shows its devices in the dock.
    let menuClosed = false // this press just closed a menu: don't act on it
    el.addEventListener('pointerdown', (e) => (menuClosed = closedBy(e)), true)
    el.addEventListener('click', (e) => {
      if (menuClosed || (e.target as HTMLElement).closest('button, input, .knob, .fader, .th-resize, .th-grip')) return
      st.setUi({ focusTrack: id, dock: { ...st.ui.dock, open: true, tab: 'devices' } })
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation() // not the lane's background menu underneath
      if (readOnly || st.locks.has(id)) return
      menu(id, el, [e.clientX, e.clientY])
    })

    // the bottom edge resizes the track
    resize.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const h0 = heights.get(id)
      el.classList.add('resizing')
      dragPointer(e, { onDrag: (mv) => heights.set(id, h0 + mv.clientY - e.clientY), onEnd: () => el.classList.remove('resizing') })
    })
    resize.addEventListener('dblclick', (e) => { e.stopPropagation(); heights.set(id, TRACK_H_DEFAULT) })

    const head: Head = { el, grip, bound: false, name, kind, kindName: '', mute, solo, arm, monitor, gain, pan, meter: m }
    heads.set(id, head)
    return head
  }

  /** Put track `id` before track `before` (last when null). */
  function moveTrack(id: string, before: string | null) {
    const rest = getTracks(doc).filter((t) => t.id !== id)
    const i = before ? rest.findIndex((t) => t.id === before) : rest.length
    if (i < 0) return
    updateTrack(doc, id, { order: orderBetween(rest[i - 1]?.order, rest[i]?.order) })
  }

  async function del(id: string) {
    if (st.locks.has(id)) return
    const t = getTracks(doc).find((x) => x.id === id)
    const n = getClips(doc).filter((c) => c.trackId === id).length
    const ok = n === 0 || await confirmModal({ title: `Delete ${t?.name ?? 'track'}?`, text: `Its ${n} clip${n > 1 ? 's' : ''} and devices go with it. You can undo this.`, action: 'delete track', danger: true })
    if (!ok) return
    st.undo.stopCapturing()
    deleteTrack(doc, id)
    st.undo.stopCapturing()
  }

  /** The track menu: rename, colour, duplicate, delete. */
  function menu(id: string, anchor: HTMLElement, at?: [number, number]) {
    const close = popover(anchor, [
      { label: 'rename', icon: 'edit', run: () => rename(id) },
      'sep',
      { label: 'duplicate track', icon: 'duplicate', run: () => { st.undo.stopCapturing(); const nid = duplicateTrack(doc, id); st.undo.stopCapturing(); if (nid) st.focus(nid) } },
      { label: 'delete track', icon: 'trash', danger: true, run: () => void del(id) },
    ], at)
    // the colour swatches go between rename and the rest
    const pop = [...document.querySelectorAll<HTMLElement>('body > .popover')].at(-1)
    const t = getTracks(doc).find((x) => x.id === id)
    if (!pop || !t) return
    const index = getTracks(doc).indexOf(t)
    const now = TRACK_COLORS.indexOf(trackColor(t, index) as (typeof TRACK_COLORS)[number])
    const sw = h('div', { className: 'th-swatches', role: 'group', 'aria-label': 'track colour' },
      ...TRACK_COLORS.map((c, i) => {
        const b = h('button', { type: 'button', className: `th-swatch${i === now ? ' on' : ''}`, title: `colour ${i + 1}`, 'aria-pressed': String(i === now),
          onclick: () => { close(); st.undo.stopCapturing(); setTrackColor(doc, id, i); st.undo.stopCapturing() } })
        b.style.setProperty('--c', c)
        return b
      }))
    pop.children[0]?.after(sw)
    const r = pop.getBoundingClientRect()
    if (r.bottom > innerHeight) pop.style.top = `${Math.max(0, innerHeight - r.height)}px`
  }

  function rename(id: string) {
    const hd = heads.get(id)
    if (!hd) return
    const input = h('input', { value: hd.name.textContent ?? '', className: 'th-rename', 'aria-label': 'track name' })
    let finished = false // (replacing the input blurs it, which would finish again)
    const done = (ok: boolean) => {
      if (finished || !input.isConnected) return
      finished = true
      if (ok && input.value.trim()) updateTrack(doc, id, { name: input.value.trim() })
      input.replaceWith(hd.name)
    }
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) }
    input.onblur = () => done(true)
    input.onclick = (e) => e.stopPropagation()
    hd.name.replaceWith(input)
    input.focus()
    input.select()
  }

  /** The kind icon: a wave for audio, a piano (or a drum, for a drum kit or drum clips) for MIDI, loops for a soundscape. */
  function kindOf(t: Track, drumTracks: Set<string>): { icon: IconName; label: string } {
    if (t.kind === 'audio') return { icon: 'wave', label: 'audio track' }
    if (t.kind === 'soundscape') return { icon: 'loop', label: 'soundscape' }
    return drumTracks.has(t.id) ? { icon: 'drum', label: 'drum track' } : { icon: 'piano', label: 'instrument track' }
  }

  function update() {
    const tracks = getTracks(doc)
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, hd] of heads) if (!ids.has(id)) { hd.meter.destroy(); hd.el.remove(); heads.delete(id) }
    // MIDI tracks that are drums: every instrument a drum, or every clip a drum grid
    const devs = getDevices(doc), clips = getClips(doc)
    const drumTracks = new Set(tracks.filter((t) => {
      if (t.kind !== 'midi') return false
      const inst = devs.filter((d) => d.trackId === t.id && DEVICES[d.type]?.instrument)
      const kit = inst.length > 0 && inst.every(isDrum)
      const cs = clips.filter((c) => c.trackId === t.id)
      return kit || (cs.length > 0 && cs.every((c) => c.kind === 'midi' && c.view === 'drums'))
    }).map((t) => t.id))
    const armed = st.ui.armedTrack
    tracks.forEach((t, i) => {
      const hd = heads.get(t.id) ?? make(t)
      const tc = trackColor(t, i)
      hd.el.style.setProperty('--tc', tc)
      hd.gain.el.style.setProperty('--fader-c', tc)
      hd.pan.el.style.setProperty('--knob-c', tc)
      hd.el.classList.toggle('focus', st.ui.focusTrack === t.id)
      hd.el.classList.toggle('compact', heights.get(t.id) < COMPACT_H)
      if (hd.name.textContent !== t.name) (hd.name.textContent = t.name), (hd.name.title = `${t.name} (double-click to rename)`)
      const k = kindOf(t, drumTracks)
      if (hd.kindName !== k.icon) {
        hd.kindName = k.icon
        hd.kind.replaceChildren(icon(k.icon, 14))
        hd.kind.title = k.label
      }
      hd.arm?.classList.toggle('on', armed === t.id)
      if (hd.monitor) {
        hd.monitor.hidden = armed !== t.id
        hd.monitor.classList.toggle('on', st.rec.monitoring)
      }
      hd.mute.classList.toggle('on', t.muted)
      hd.solo.classList.toggle('on', t.soloed)
      hd.mute.setAttribute('aria-pressed', String(t.muted))
      hd.solo.setAttribute('aria-pressed', String(t.soloed))
      hd.gain.set(t.gain)
      hd.pan.set(t.pan ?? 0)
      const locked = readOnly || st.locks.has(t.id)
      hd.gain.setDisabled(locked)
      hd.pan.setDisabled(locked)
    })
  }

  // --- meters: post-fader output peaks; while a track is armed (and nothing plays it back), its input level
  let masterMeter: Meter | null = null
  const offs = [
    st.on('doc', update),
    st.on('ui', (p) => { if ('armedTrack' in p || 'focusTrack' in p) update() }),
    st.on('transport', update),
    st.on('meters', (m) => {
      for (const [id, hd] of heads) {
        const v = m.tracks.get(id)
        if (v) hd.meter.push(v[0], v[1])
      }
      masterMeter?.push(m.master[0], m.master[1])
    }),
    st.on('level', (m) => {
      const hd = st.ui.armedTrack ? heads.get(st.ui.armedTrack) : null
      hd?.meter.push(m.level)
      hd?.el.classList.toggle('clipping', m.clipped)
    }),
    heights.on(update),
  ]
  return {
    /** The header element for `t` (made on first use). */
    headFor: (t: Track) => (heads.get(t.id) ?? (update(), heads.get(t.id)) ?? make(t)).el,
    /** The master's header: a click focuses the master bus (its devices show in the dock). */
    master() {
      masterMeter = meter({ orientation: 'horizontal', stereo: true })
      masterMeter.el.classList.add('master-meter')
      const el = h('div', { className: 'head track-head master-head', title: 'effects on the whole mix: click to show them in the dock' },
        h('span', { className: 'th-name' }, 'master'), masterMeter.el)
      el.onclick = (e) => {
        if ((e.target as HTMLElement).closest('.meter-el')) return
        st.setUi({ focusTrack: MASTER_TRACK, dock: { ...st.ui.dock, open: true, tab: 'devices' } })
      }
      return el
    },
    /** The lanes built `lane` around `t`'s header: its grip now drags that lane up and down the list. */
    attach(t: Track, lane: HTMLElement) {
      const hd = heads.get(t.id)
      lane.dataset.lane = t.id
      if (!hd || hd.bound || readOnly) return
      hd.bound = true
      dragToReorder(hd.grip, lane, {
        start: () => lane.classList.add('reordering'),
        drop: (before) => { st.undo.stopCapturing(); moveTrack(t.id, before); st.undo.stopCapturing() },
        end: () => lane.classList.remove('reordering'),
      }, { attr: 'lane', axis: 'y' })
    },
    /** Open track `id`'s menu at a point (the lanes' background menu offers it too). */
    menu: (id: string, at: [number, number]) => { const hd = heads.get(id); if (hd) menu(id, hd.el, at) },
    destroy() {
      offs.forEach((f) => f())
      for (const hd of heads.values()) hd.meter.destroy()
      masterMeter?.destroy()
    },
  }
}
