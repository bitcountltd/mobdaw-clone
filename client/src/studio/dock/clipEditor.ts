// The dock's clip tab: the open clip's editor. A MIDI clip gets the piano roll (or the drum grid for a `view: 'drums'`
// clip) at its own horizontal zoom; an audio clip gets a small panel (gain, fades, fade shape, loop).
import {
  DEVICES, clipsMap, getClips, getDevices, getNotes, getSamples, getTracks, isLooping, updateClip,
  type AudioClip, type Clip, type FadeShape, type MidiClip,
} from '@mobdaw/shared'
import { h } from '../../dom'
import { clamp } from '../../ui/blocks'
import { drumGrid } from '../../ui/drumGrid'
import { noteEditor } from '../../ui/noteEditor'
import { fmtDb, gainToPos, posToGain, ticks, UNITY_POS } from '../../ui/slider'
import { valueTip } from '../../ui/valueTip'
import { setLoopOff, setLoopOn } from '../arrange/clipOps'
import type { Studio } from '../studio'

const FADE_SHAPES: [FadeShape, string][] = [[0, 'equal power'], [1, 'linear'], [2, 's-curve']]

export function mountClipEditor(st: Studio) {
  const { doc, undo, readOnly } = st
  const ne = noteEditor({
    doc, undo, readOnly,
    selectNote: (id) => st.setUi({ note: id }),
    noteLive: (trackId, pitch, velocity, on) => st.pb?.noteLive(trackId, pitch, velocity, on),
  })
  const dg = drumGrid({ doc, undo, readOnly })
  const scroller = h('div', { className: 'dock-scroll' }) // horizontal scroll of the MIDI editors
  const empty = h('div', { className: 'dock-empty dim' }, 'double-click a clip to edit it here.')
  const audio = audioPanel(st)
  const el = h('div', { className: 'clip-editor' }, empty, scroller, audio.el)

  let pps = 0 // the editors' own zoom (px per second); 0: fit the clip to the dock on the next draw
  let shownId: string | null = null
  scroller.addEventListener('scroll', () => { if (scroller.firstElementChild === ne.el) draw() }, { passive: true }) // (the piano roll's keys stick to the left edge)
  // shift + ctrl + wheel zooms the time axis (plain ctrl + wheel is the piano roll's pitch zoom)
  scroller.addEventListener('wheel', (e) => {
    if (!((e.ctrlKey || e.metaKey) && e.shiftKey) || !pps) return
    e.preventDefault()
    const r = scroller.getBoundingClientRect()
    const t = (e.clientX - r.left + scroller.scrollLeft) / pps
    pps = clamp(pps * Math.exp(-(e.deltaY || e.deltaX) * 0.01), 10, 2000)
    draw()
    scroller.scrollLeft = t * pps - (e.clientX - r.left)
  }, { passive: false })

  function draw() {
    const id = st.ui.editing
    const clip = id ? getClips(doc).find((c) => c.id === id) : undefined
    if (id !== shownId) { // a different clip: fit it, and let the piano roll re-centre on its notes
      shownId = id
      pps = 0
      ne.reset()
      dg.reset()
      scroller.scrollLeft = 0
    }
    empty.hidden = !!clip
    scroller.hidden = clip?.kind !== 'midi'
    audio.el.hidden = clip?.kind !== 'audio'
    el.classList.toggle('locked', !!clip && st.locks.has(clip.trackId))
    if (!clip) return
    if (clip.kind === 'audio') return audio.update(clip)
    drawMidi(clip)
  }

  function drawMidi(c: MidiClip) {
    const editor = c.view === 'drums' ? dg : ne
    if (scroller.firstElementChild !== editor.el) scroller.replaceChildren(editor.el)
    const seconds = (c.lengthTicks / c.ppq) * (60 / c.bpm)
    // fit the clip to the dock's width (once the dock is laid out; until then just for this draw)
    const fit = clamp((Math.max(200, scroller.clientWidth || 800) - 24) / Math.max(seconds, 0.1), 10, 2000)
    if (!pps && scroller.clientWidth) pps = fit
    const zoom = pps || fit
    const notes = getNotes(doc).filter((n) => n.clipId === c.id)
    const width = (c.lengthTicks / c.ppq) * ((zoom * 60) / c.bpm)
    editor.el.style.width = `${Math.max(width, scroller.clientWidth)}px`
    if (editor === dg) {
      const instruments = getDevices(doc).filter((d) => d.trackId === c.trackId && DEVICES[d.type]?.instrument)
      dg.update(c, notes, instruments, zoom, c.lengthTicks)
    } else ne.update(c, notes, st.ui.note, zoom, c.lengthTicks)
  }

  const offs = [
    st.on('doc', draw),
    st.on('ui', (p) => { if ('editing' in p || 'note' in p || 'dock' in p) draw() }),
  ]
  draw()
  return { el, draw, destroy: () => offs.forEach((f) => f()) }
}

/** An audio clip's settings: its gain, fades and fade shape, and whether it loops. */
function audioPanel(st: Studio) {
  const { doc, readOnly } = st
  let clip: AudioClip | null = null
  const name = h('strong', { className: 'ac-name' })
  const where = h('span', { className: 'dim' })
  const gain = h('input', { type: 'range', min: 0, max: 1, step: 'any', title: 'clip gain', disabled: readOnly })
  ticks(gain, [UNITY_POS])
  valueTip(gain, () => fmtDb(posToGain(gain.valueAsNumber)))
  gain.onpointerdown = () => st.undo.stopCapturing()
  gain.oninput = () => clip && updateClip(doc, clip.id, { gain: posToGain(gain.valueAsNumber) })
  const ms = (smp: number) => Math.round((smp / st.rate) * 1000)
  const fadeInput = (title: string, key: 'fadeIn' | 'fadeOut') => {
    const i = h('input', { type: 'number', min: 0, step: 10, title, disabled: readOnly })
    i.onchange = () => {
      if (!clip || !(Number(i.value) >= 0)) return
      const smp = Math.round((Number(i.value) / 1000) * st.rate)
      updateClip(doc, clip.id, { [key]: Math.min(smp, clip.length) })
    }
    return i
  }
  const fadeIn = fadeInput('fade in (ms)', 'fadeIn')
  const fadeOut = fadeInput('fade out (ms)', 'fadeOut')
  const fadeShape = h('select', { title: 'fade shape', disabled: readOnly }, ...FADE_SHAPES.map(([v, l]) => h('option', { value: String(v) }, l)))
  fadeShape.onchange = () => clip && updateClip(doc, clip.id, { fadeShape: Number(fadeShape.value) as FadeShape })
  const loop = h('input', { type: 'checkbox', title: 'repeat the clip (drag its right edge to extend it)', disabled: readOnly })
  loop.onchange = () => {
    const c = clip && clipsMap(doc).get(clip.id)?.toJSON() as Clip | undefined
    if (!c) return
    if (loop.checked) setLoopOn(doc, st.rate, c, false)
    else setLoopOff(doc, c)
  }
  const field = (label: string, input: HTMLElement) => h('label', { className: 'ac-field' }, h('span', { className: 'dim' }, label), input)
  const el = h('div', { className: 'audio-clip' },
    h('div', { className: 'ac-head' }, name, where),
    h('div', { className: 'ac-fields' },
      field('gain', gain), field('fade in, ms', fadeIn), field('fade out, ms', fadeOut), field('fade shape', fadeShape), field('loop', loop)))

  function update(c: AudioClip) {
    clip = c
    const meta = getSamples(doc)[c.sourceHash]
    const text = meta?.name ?? 'audio clip'
    if (name.textContent !== text) name.textContent = text
    const track = getTracks(doc).find((t) => t.id === c.trackId)
    where.textContent = `on ${track?.name ?? 'a track'} · ${(c.length / st.rate).toFixed(2)} s`
    if (document.activeElement !== gain) gain.value = String(gainToPos(c.gain))
    if (document.activeElement !== fadeIn) fadeIn.value = String(ms(c.fadeIn))
    if (document.activeElement !== fadeOut) fadeOut.value = String(ms(c.fadeOut))
    fadeShape.value = String(c.fadeShape ?? 0)
    loop.checked = isLooping(c)
  }
  return { el, update }
}
