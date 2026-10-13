// Track headers: colour, name, mute / solo / arm / monitor, the input meter, and gain. A click on a header's background
// focuses the track (the dock shows its devices); right-click offers rename / delete. The lanes place each header at the
// left of its row; this module builds and updates them from the Studio.
import { MASTER_TRACK, deleteTrack, getTracks, trackColor, tracksMap, updateTrack, type Track } from '@mobdaw/shared'
import { shape } from '../../audio/probe'
import { h } from '../../dom'
import { closedBy, popover } from '../../ui/popover'
import { fmtDb, gainToPos, posToGain, ticks, UNITY_POS } from '../../ui/slider'
import { valueTip } from '../../ui/valueTip'
import type { Studio } from '../studio'

type Head = {
  el: HTMLElement; name: HTMLElement; mute: HTMLButtonElement; solo: HTMLButtonElement
  record: HTMLButtonElement | null; listen: HTMLButtonElement | null; meter: HTMLElement | null; gain: HTMLInputElement
}

export function mountTrackHeaders(st: Studio) {
  const { doc, readOnly } = st
  const heads = new Map<string, Head>()

  function make(t: Track): Head {
    const name = h('span', { className: 'name', ondblclick: () => readOnly || rename(t.id) })
    const mute = h('button', { className: 'mute', title: 'mute', disabled: readOnly, onclick: () => {
      updateTrack(doc, t.id, { muted: !tracksMap(doc).get(t.id)?.get('muted') })
    } }, 'm')
    const solo = h('button', { className: 'solo', title: 'solo', disabled: readOnly, onclick: () => {
      updateTrack(doc, t.id, { soloed: !tracksMap(doc).get(t.id)?.get('soloed') })
    } }, 's')
    const record = t.kind === 'audio' ? h('button', { className: 'record', title: 'arm for recording', disabled: readOnly, onclick: () => void st.rec.arm(t.id) }, 'r') : null
    const listen = record ? h('button', { className: 'listen', hidden: true, title: 'monitor the input through this track\'s effects (use headphones)',
      onclick: () => st.rec.setMonitoring(!st.rec.monitoring) }, 'i') : null
    const meter = record ? h('i', { className: 'meter', hidden: true, title: 'input level' }) : null
    const gain = h('input', { type: 'range', min: 0, max: 1, step: 'any', title: 'gain', disabled: readOnly })
    ticks(gain, [UNITY_POS]) // 0 dB; the top of the range is +6 dB
    valueTip(gain, () => fmtDb(posToGain(gain.valueAsNumber)))
    gain.oninput = () => updateTrack(doc, t.id, { gain: posToGain(gain.valueAsNumber) })
    gain.onpointerdown = () => st.undo.stopCapturing()
    const el = h('div', { className: 'head track-head', title: 'click to show the track\'s devices; right-click for its menu' },
      name, h('div', { className: 'ctl track-btns' }, mute, solo, record, listen, meter), h('div', { className: 'ctl' }, gain))
    // A click on the header (not on its controls) focuses the track and shows its devices in the dock.
    let menuClosed = false // this press just closed a menu: don't act on it
    el.addEventListener('pointerdown', (e) => (menuClosed = closedBy(e)), true)
    el.addEventListener('click', (e) => {
      if (menuClosed || (e.target as HTMLElement).closest('button, input')) return
      st.setUi({ focusTrack: t.id, dock: { ...st.ui.dock, open: true, tab: 'devices' } })
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation() // not the lane's background menu underneath
      if (readOnly || st.locks.has(t.id)) return
      popover(el, [['rename', () => rename(t.id)], ['delete track', () => void del(t.id)]], [e.clientX, e.clientY])
    })
    const head: Head = { el, name, mute, solo, record, listen, meter, gain }
    heads.set(t.id, head)
    return head
  }

  const del = (id: string) => !st.locks.has(id) && confirm('delete this track and its clips?') && deleteTrack(doc, id)

  function rename(id: string) {
    const hd = heads.get(id)
    if (!hd) return
    const input = h('input', { value: hd.name.textContent ?? '', className: 'rename' })
    const done = (ok: boolean) => {
      if (!input.isConnected) return
      if (ok && input.value.trim()) updateTrack(doc, id, { name: input.value.trim() })
      input.replaceWith(hd.name)
    }
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) }
    input.onblur = () => done(true)
    hd.name.replaceWith(input)
    input.focus()
    input.select()
  }

  function update() {
    const tracks = getTracks(doc)
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, hd] of heads) if (!ids.has(id)) { hd.el.remove(); heads.delete(id) }
    const armed = st.ui.armedTrack
    tracks.forEach((t, i) => {
      const hd = heads.get(t.id) ?? make(t)
      hd.el.style.setProperty('--tc', trackColor(t, i))
      hd.el.classList.toggle('focus', st.ui.focusTrack === t.id)
      if (hd.name.textContent !== t.name) hd.name.textContent = t.name
      hd.record?.classList.toggle('on', armed === t.id)
      if (hd.meter) hd.meter.hidden = armed !== t.id
      if (hd.listen) {
        hd.listen.hidden = armed !== t.id
        hd.listen.classList.toggle('on', st.rec.monitoring)
      }
      hd.mute.classList.toggle('on', t.muted)
      hd.solo.classList.toggle('on', t.soloed)
      if (document.activeElement !== hd.gain) hd.gain.value = String(gainToPos(t.gain))
    })
  }

  /** The armed track's input meter: level on the drawn scale, red once the input has hit full scale. */
  function level(m: { level: number; clipped: boolean }) {
    const meter = st.ui.armedTrack ? heads.get(st.ui.armedTrack)?.meter : null
    if (!meter) return
    meter.style.setProperty('--lv', String(shape(m.level)))
    meter.classList.toggle('clipping', m.clipped) // (not 'clip': that is the clips' class, with its own ::before)
  }

  const offs = [
    st.on('doc', update),
    st.on('ui', (p) => { if ('armedTrack' in p || 'focusTrack' in p) update() }),
    st.on('transport', update),
    st.on('level', level),
  ]
  return {
    /** The header element for `t` (made on first use). */
    headFor: (t: Track) => (heads.get(t.id) ?? (update(), heads.get(t.id)) ?? make(t)).el,
    /** The master's header: a click focuses the master bus (its devices show in the dock). */
    master() {
      const el = h('div', { className: 'head track-head master-head', title: 'effects on the whole mix: click to show them in the dock' }, h('span', { className: 'name' }, 'master'))
      el.onclick = () => st.setUi({ focusTrack: MASTER_TRACK, dock: { ...st.ui.dock, open: true, tab: 'devices' } })
      return el
    },
    destroy: () => offs.forEach((f) => f()),
  }
}
