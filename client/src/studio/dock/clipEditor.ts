// The dock's clip tab: the open clip's editor. A MIDI clip gets the piano roll (or the drum grid for a `view: 'drums'`
// clip) at its own horizontal zoom; an audio clip gets a panel with its waveform, gain, fades and loop.
// The tab's controls (length, loop, view, grid, zoom) live in `tools`, which the dock shows in its bar.
import {
  DEVICES, GRID_SIZES, clipsMap, getClips, getDevices, getNotes, getSamples, getTracks, isLooping, patternTicks, setMidiView, trackColor, updateClip,
  type AudioClip, type Clip, type FadeShape, type MidiClip,
} from '@mobdaw/shared'
import { peaksFor, storedPeaks, drawWave } from '../../audio/peaks'
import { h } from '../../dom'
import { icon } from '../../theme/icons'
import { iconButton, knob, numberField, segmented, toggle, tooltip } from '../../theme/controls'
import { clamp } from '../../ui/blocks'
import { drumGrid } from '../../ui/drumGrid'
import { noteEditor } from '../../ui/noteEditor'
import { fmtDb, gainToPos, posToGain, UNITY_POS } from '../../ui/slider'
import { setLoopOff, setLoopOn } from '../arrange/clipOps'
import { registerKeys } from '../keys'
import type { Studio } from '../studio'
import { barsText, gridTicks, type EditorGrid } from './noteOps'
import './editors.css'

const FADE_SHAPES: { value: string; label: string; title: string }[] = [
  { value: '0', label: 'equal power', title: 'equal-power fades' }, { value: '1', label: 'linear', title: 'linear fades' }, { value: '2', label: 's-curve', title: 's-curve fades' },
]
const GRID_KEY = 'mobdaw.editor.grid'

export type PaneTitle = { name: string; sub: string; color: string | null }

export function mountClipEditor(st: Studio) {
  const { doc, undo, readOnly } = st
  let grid: EditorGrid = (() => { try { const g = JSON.parse(localStorage.getItem(GRID_KEY) ?? '"studio"'); return g } catch { return 'studio' } })()
  const bpb = () => st.tempo().beatsPerBar
  const step = (c: MidiClip) => gridTicks(grid === 'studio' ? st.ui.grid : grid, c.ppq, bpb())
  const ne = noteEditor({
    doc, undo, readOnly, step, beatsPerBar: bpb,
    selectNote: (id) => st.setUi({ note: id }),
    noteLive: (trackId, pitch, velocity, on) => st.pb?.noteLive(trackId, pitch, velocity, on),
    status: (t) => st.status(t),
  })
  const dg = drumGrid({ doc, undo, readOnly, step, beatsPerBar: bpb, noteLive: (t, p, v, on) => st.pb?.noteLive(t, p, v, on), status: (t) => st.status(t) })
  const body = h('div', { className: 'ce-body' })
  const empty = h('div', { className: 'dock-empty' },
    h('div', { className: 'dock-empty-icon' }, icon('piano', 22)),
    h('p', {}, 'Click a clip to edit it here.'),
    h('p', { className: 'dim' }, 'Instrument clips open as a piano roll or a drum grid; audio clips show their gain and fades.'))
  const audio = audioPanel(st)
  const el = h('div', { className: 'clip-editor' }, empty, body, audio.el)

  // --- tools (shown in the dock's bar)
  const lengthF = numberField({ value: 4, min: 0.25, max: 512, step: 0.25, width: '44px', title: 'clip length in bars (drag or click to type)', format: (v) => barsText(v, 1, 1), onChange: (v) => setLength(v) })
  const loopT = toggle(h('span', { className: 'ce-loop-in' }, icon('loop', 14), 'loop'), { className: 'ce-loop-t', onChange: (on) => setLoop(on) })
  tooltip(loopT.el, 'repeat the clip: its pattern plays again to the end of the clip')
  const loopF = numberField({ value: 1, min: 0.25, max: 512, step: 0.25, width: '44px', title: 'loop length in bars', format: (v) => barsText(v, 1, 1), onChange: (v) => setLoopLen(v) })
  const viewSeg = segmented<'piano' | 'drums'>([{ value: 'piano', icon: 'piano', label: 'piano roll' }, { value: 'drums', icon: 'drum', label: 'drum grid' }], 'piano', (v) => { const c = midi(); if (c) setMidiView(doc, c.id, v) })
  const gridSel = h('select', { className: 'ce-grid', title: 'snap for note edits (alt: no snap)' }) as HTMLSelectElement
  const fillGrid = () => {
    const studioLabel = GRID_SIZES.find((g) => g.value === st.ui.grid)?.label ?? '1/16'
    gridSel.replaceChildren(h('option', { value: '"studio"' }, `snap ${studioLabel}`), ...GRID_SIZES.map((g) => h('option', { value: JSON.stringify(g.value) }, g.value === 0 ? 'snap off' : g.label)))
    gridSel.value = JSON.stringify(grid)
  }
  gridSel.onchange = () => {
    grid = JSON.parse(gridSel.value) as EditorGrid
    try { localStorage.setItem(GRID_KEY, JSON.stringify(grid)) } catch { /* not remembered */ }
    draw()
  }
  gridSel.onkeydown = (e) => e.stopPropagation()
  const quantB = h('button', { className: 'btn sm ce-q', title: 'quantize the selected notes, or all of them (q)', onclick: () => ne.commands.quantize() }, 'quantize')
  const zoomBy = (f: number) => { if (pps) { const sc = scroller(); const mid = sc ? (sc.scrollLeft + sc.clientWidth / 2) / pps : 0; pps = clamp(pps * f, 10, 2000); draw(); if (sc) sc.scrollLeft = mid * pps - sc.clientWidth / 2 } }
  const zoomOut = iconButton('zoom-out', 'zoom out (ctrl+shift+wheel)', () => zoomBy(1 / 1.4), 'sm')
  const zoomIn = iconButton('zoom-in', 'zoom in (ctrl+shift+wheel)', () => zoomBy(1.4), 'sm')
  const fitB = h('button', { className: 'btn sm', title: 'fit the clip to the dock', onclick: () => { pps = 0; draw() } }, 'fit')
  const field = (label: string, ...kids: HTMLElement[]) => h('label', { className: 'ce-field' }, h('span', { className: 'dim' }, label), ...kids)
  const midiTools = h('div', { className: 'ce-tools' },
    field('length', lengthF.el, h('span', { className: 'dim' }, 'bars')),
    h('span', { className: 'ce-loop' }, loopT.el, loopF.el),
    h('span', { className: 'ce-sep' }), viewSeg.el, gridSel, quantB,
    h('span', { className: 'ce-sep' }), zoomOut, fitB, zoomIn)
  const tools = h('div', { className: 'ce-toolbar' }, midiTools)
  for (const x of [lengthF.el, loopF.el]) x.disabled = readOnly
  loopT.el.disabled = readOnly

  const midi = () => { const c = st.ui.editing ? getClips(doc).find((x) => x.id === st.ui.editing) : undefined; return c?.kind === 'midi' ? c : undefined }
  const barT = (c: MidiClip) => c.ppq * bpb()
  function setLength(bars: number) {
    const c = midi()
    if (!c) return
    const t = Math.round(bars * barT(c))
    undo.stopCapturing()
    if (isLooping(c) && t <= c.loopTicks!) updateClip(doc, c.id, { lengthTicks: t, loopTicks: 0, forever: false })
    else updateClip(doc, c.id, { lengthTicks: t })
  }
  function setLoop(on: boolean) {
    const c = midi()
    if (!c) return
    undo.stopCapturing()
    if (on) setLoopOn(doc, st.rate, c as Clip, false)
    else setLoopOff(doc, c as Clip)
  }
  function setLoopLen(bars: number) {
    const c = midi()
    if (!c) return
    const t = Math.round(bars * barT(c))
    undo.stopCapturing()
    if (t < c.lengthTicks) updateClip(doc, c.id, { loopTicks: t })
    else updateClip(doc, c.id, { loopTicks: t, lengthTicks: t * 2 })
  }

  let pps = 0 // the editors' own zoom (px per second); 0: fit the clip to the dock on the next draw
  let shownId: string | null = null
  const editorOf = (c: MidiClip) => (c.view === 'drums' ? dg : ne)
  const scroller = () => { const c = midi(); return c ? editorOf(c).scroller : null }
  // ctrl + shift + wheel zooms the time axis (plain ctrl + wheel is the piano roll's pitch zoom)
  body.addEventListener('wheel', (e) => {
    if (!((e.ctrlKey || e.metaKey) && e.shiftKey) || !pps) return
    const sc = scroller()
    if (!sc) return
    e.preventDefault()
    const c = midi()!
    const r = sc.getBoundingClientRect()
    const off = e.clientX - r.left - editorOf(c).keysWidth
    const t = (off + sc.scrollLeft) / pps
    pps = clamp(pps * Math.exp(-(e.deltaY || e.deltaX) * 0.01), 10, 2000)
    draw()
    sc.scrollLeft = t * pps - off
  }, { passive: false })

  function draw() {
    const id = st.ui.editing
    const clip = id ? getClips(doc).find((c) => c.id === id) : undefined
    if (id !== shownId) { // a different clip: fit it, and let the piano roll re-centre on its notes
      shownId = id
      pps = 0
      ne.reset()
      dg.reset()
      ne.scroller.scrollLeft = dg.scroller.scrollLeft = 0
    }
    empty.hidden = !!clip
    body.hidden = clip?.kind !== 'midi'
    audio.el.hidden = clip?.kind !== 'audio'
    midiTools.hidden = clip?.kind !== 'midi'
    el.classList.toggle('locked', !!clip && st.locks.has(clip.trackId))
    if (!clip) return
    if (clip.kind === 'audio') return audio.update(clip, colorOf(clip.trackId))
    drawMidi(clip)
  }
  const colorOf = (trackId: string) => {
    const tracks = getTracks(doc)
    const i = tracks.findIndex((t) => t.id === trackId)
    return i < 0 ? 'var(--tc-1)' : trackColor(tracks[i], i)
  }

  function drawMidi(c: MidiClip) {
    const editor = editorOf(c)
    if (body.firstElementChild !== editor.el) body.replaceChildren(editor.el)
    const seconds = (c.lengthTicks / c.ppq) * (60 / c.bpm)
    const avail = (editor.scroller.clientWidth || body.clientWidth || 800) - editor.keysWidth - 16
    const fit = clamp(Math.max(160, avail) / Math.max(seconds, 0.1), 10, 2000)
    if (!pps && editor.scroller.clientWidth) pps = fit
    const zoom = pps || fit
    const notes = getNotes(doc).filter((n) => n.clipId === c.id)
    const view = { tc: colorOf(c.trackId), pps: zoom, extent: c.lengthTicks }
    if (editor === dg) dg.update(c, notes, getDevices(doc).filter((d) => d.trackId === c.trackId && DEVICES[d.type]?.instrument), view)
    else ne.update(c, notes, st.ui.note, view)
    // tools
    fillGrid()
    viewSeg.set(c.view === 'drums' ? 'drums' : 'piano')
    quantB.hidden = c.view === 'drums'
    lengthF.set(c.lengthTicks / barT(c))
    const looping = isLooping(c)
    loopT.set(looping)
    loopF.el.hidden = !looping
    loopF.set(patternTicks(c) / barT(c))
    playhead()
  }

  function playhead() {
    const c = midi()
    if (!c) return
    const tick = ((st.position() - c.start) / st.rate) * (c.bpm / 60) * c.ppq
    editorOf(c).setPlayhead(st.playing || st.position() > 0 ? tick : null)
  }

  function title(): PaneTitle | null {
    const clip = st.ui.editing ? getClips(doc).find((c) => c.id === st.ui.editing) : undefined
    if (!clip) return null
    const track = getTracks(doc).find((t) => t.id === clip.trackId)
    const sub = clip.kind === 'audio'
      ? getSamples(doc)[clip.sourceHash]?.name ?? 'audio clip'
      : clip.view === 'drums' ? 'drum pattern' : 'notes'
    const name = track?.name ?? 'clip'
    return { name, sub: sub === name ? 'audio clip' : sub, color: colorOf(clip.trackId) }
  }

  // The piano roll's keys: while the pointer is over the clip tab or it has the focus, and a piano roll is showing.
  let over = false
  el.addEventListener('pointerenter', () => (over = true))
  el.addEventListener('pointerleave', () => (over = false))
  const roll = () => {
    const c = midi()
    return !!c && c.view !== 'drums' && st.ui.dock.open && st.ui.dock.tab === 'clip' && (over || el.contains(document.activeElement))
  }
  const sel = () => roll() && ne.commands.hasSelection()
  const G = 'Clip editor'
  const offKeys = registerKeys(st, [
    { key: 'q', when: roll, run: () => ne.commands.quantize(), label: 'quantize the selected notes (or all)', group: G, priority: 10 },
    { key: 'arrowup', when: sel, run: () => ne.commands.transpose(1), label: 'notes up a semitone', group: G, priority: 10, repeat: true },
    { key: 'arrowdown', when: sel, run: () => ne.commands.transpose(-1), label: 'notes down a semitone', group: G, priority: 10, repeat: true },
    { key: 'arrowup', mods: { shift: true }, when: sel, run: () => ne.commands.transpose(12), label: 'notes up an octave', group: G, priority: 10, repeat: true },
    { key: 'arrowdown', mods: { shift: true }, when: sel, run: () => ne.commands.transpose(-12), label: 'notes down an octave', group: G, priority: 10, repeat: true },
    { key: 'arrowleft', when: sel, run: () => ne.commands.nudge(-1), label: 'notes a grid step earlier', group: G, priority: 10, repeat: true },
    { key: 'arrowright', when: sel, run: () => ne.commands.nudge(1), label: 'notes a grid step later', group: G, priority: 10, repeat: true },
    { key: 'arrowleft', mods: { shift: true }, when: sel, run: () => ne.commands.nudge(-1, true), label: 'notes a bar earlier', group: G, priority: 10, repeat: true },
    { key: 'arrowright', mods: { shift: true }, when: sel, run: () => ne.commands.nudge(1, true), label: 'notes a bar later', group: G, priority: 10, repeat: true },
    { key: 'a', mods: { mod: true }, when: roll, run: () => ne.commands.selectAll(), label: 'select all notes', group: G, priority: 10, readOnly: true },
    { key: ['delete', 'backspace'], when: sel, run: () => ne.commands.remove(), label: 'delete the selected notes', group: G, priority: 10 },
    { key: 'escape', when: sel, run: () => ne.commands.clearSelection(), label: 'clear the note selection', group: G, priority: 10, readOnly: true },
  ])

  // the editors measure themselves (fit, centring on the notes): draw again when the dock's size settles
  let lastSize = ''
  const ro = new ResizeObserver(() => {
    const size = `${el.clientWidth}x${el.clientHeight}`
    if (size !== lastSize && el.clientHeight > 40) (lastSize = size), draw()
  })
  ro.observe(el)

  const offs = [
    offKeys,
    () => ro.disconnect(),
    st.on('doc', draw),
    st.on('ui', (p) => { if ('editing' in p || 'note' in p || 'dock' in p || 'grid' in p) draw() }),
    st.on('tick', playhead),
    // notes played live on the open clip's track light the piano roll's keys
    st.on('liveNote', (n) => { const c = midi(); if (c && c.trackId === n.trackId) ne.liveKey(n.pitch, n.on) }),
    st.on('ui', (p) => { if ('editing' in p) ne.clearLive() }),
    st.on('transport', playhead),
  ]
  draw()
  return { el, tools, title, draw, destroy: () => offs.forEach((f) => f()) }
}

/** An audio clip's settings: its waveform with the fades over it, gain, fades and fade shape, and whether it loops. */
function audioPanel(st: Studio) {
  const { doc, readOnly } = st
  let clip: AudioClip | null = null
  const ms = (smp: number) => (smp / st.rate) * 1000
  const smp = (msv: number) => Math.round((msv / 1000) * st.rate)
  const commit = () => st.undo.stopCapturing()

  const canvas = h('canvas', { className: 'ac-canvas' })
  const fades = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  fades.setAttribute('class', 'ac-fades')
  fades.setAttribute('preserveAspectRatio', 'none')
  const fadePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  const shade = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  shade.setAttribute('class', 'ac-shade')
  fadePath.setAttribute('class', 'ac-env')
  fades.append(shade, fadePath)
  const hIn = h('i', { className: 'ac-handle in', title: 'drag to set the fade in' })
  const hOut = h('i', { className: 'ac-handle out', title: 'drag to set the fade out' })
  const passNote = h('span', { className: 'ac-pass dim' })
  const wave = h('div', { className: 'ac-wave' }, canvas, fades, hIn, hOut, passNote)

  const gain = knob({ value: UNITY_POS, min: 0, max: 1, def: UNITY_POS, label: 'gain', size: 40, format: (p) => fmtDb(posToGain(p)), disabled: readOnly,
    onInput: (p) => clip && updateClip(doc, clip.id, { gain: posToGain(p) }), onChange: commit })
  const fadeIn = knob({ value: 0, min: 0, max: 10000, def: 0, scale: 'pow', unit: 'ms', label: 'fade in', size: 40, disabled: readOnly,
    onInput: (v) => clip && updateClip(doc, clip.id, { fadeIn: Math.min(smp(v), clip.length) }), onChange: commit })
  const fadeOut = knob({ value: 0, min: 0, max: 10000, def: 0, scale: 'pow', unit: 'ms', label: 'fade out', size: 40, disabled: readOnly,
    onInput: (v) => clip && updateClip(doc, clip.id, { fadeOut: Math.min(smp(v), clip.length) }), onChange: commit })
  const shape = segmented(FADE_SHAPES, '0', (v) => clip && updateClip(doc, clip.id, { fadeShape: Number(v) as FadeShape }))
  const loop = toggle({ icon: 'loop' }, { title: 'repeat the clip (drag its right edge in the arrangement to extend it)', onChange: (on) => {
    const c = clip && clipsMap(doc).get(clip.id)?.toJSON() as Clip | undefined
    if (!c) return
    st.undo.stopCapturing()
    if (on) setLoopOn(doc, st.rate, c, false)
    else setLoopOff(doc, c)
  } })
  loop.el.disabled = readOnly
  const info = h('div', { className: 'ac-info' })
  const group = (label: string, ...kids: HTMLElement[]) => h('div', { className: 'ac-group' }, h('div', { className: 'ac-label' }, label), h('div', { className: 'ac-row' }, ...kids))
  const el = h('div', { className: 'audio-clip' }, wave,
    h('div', { className: 'ac-controls' },
      group('level', gain.el),
      group('fades', fadeIn.el, fadeOut.el),
      group('fade shape', shape.el),
      group('loop', loop.el),
      info))

  // drag the handles to set the fades
  const dragFade = (which: 'fadeIn' | 'fadeOut') => (e: PointerEvent) => {
    if (readOnly || !clip || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const c = clip
    const r = wave.getBoundingClientRect()
    st.undo.stopCapturing()
    const move = (m: PointerEvent) => {
      const f = clamp((m.clientX - r.left) / r.width, 0, 1)
      const v = Math.round((which === 'fadeIn' ? f : 1 - f) * c.length)
      updateClip(doc, c.id, { [which]: Math.min(v, c.length - (which === 'fadeIn' ? c.fadeOut : c.fadeIn)) })
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); st.undo.stopCapturing() }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  hIn.onpointerdown = dragFade('fadeIn')
  hOut.onpointerdown = dragFade('fadeOut')

  function drawWaveform(c: AudioClip) {
    const meta = getSamples(doc)[c.sourceHash]
    const peaks = meta ? peaksFor(st.s.projectId, c.sourceHash, st.rate) ?? storedPeaks(meta, st.rate) : undefined
    const dpr = devicePixelRatio || 1
    const w = Math.max(1, Math.round(wave.clientWidth * dpr)), hh = Math.max(1, Math.round(wave.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== hh) (canvas.width = w), (canvas.height = hh)
    const looping = isLooping(c)
    const frames = looping ? c.loopLength! : c.length
    passNote.textContent = looping ? 'one pass of the loop' : ''
    if (peaks) drawWave(canvas, peaks, c.sourceOffset, frames)
    else canvas.getContext('2d')?.clearRect(0, 0, w, hh)
    // the fade envelope over the clip's extent
    const W = 1000, H = 100
    fades.setAttribute('viewBox', `0 0 ${W} ${H}`)
    const fi = (c.fadeIn / c.length) * W, fo = W - (c.fadeOut / c.length) * W
    const sh = c.fadeShape ?? 0
    const g = (t: number) => (sh === 1 ? t : sh === 2 ? t * t * (3 - 2 * t) : Math.sin((t * Math.PI) / 2))
    const curve = (x0: number, x1: number, up: boolean) => {
      let d = ''
      for (let i = 0; i <= 24; i++) {
        const t = i / 24
        d += `L${(x0 + (x1 - x0) * t).toFixed(1)} ${(H - g(up ? t : 1 - t) * H).toFixed(1)}`
      }
      return d
    }
    const pts = `${curve(0, fi, true)}L${fo.toFixed(1)} 0${curve(fo, W, false)}`
    fadePath.setAttribute('d', `M0 ${H}${pts}`)
    shade.setAttribute('d', `M0 0L0 ${H}${pts}L${W} 0Z`)
    hIn.style.left = `${(fi / W) * 100}%`
    hOut.style.left = `${(fo / W) * 100}%`
  }

  function update(c: AudioClip, color: string) {
    clip = c
    el.style.setProperty('--tc', color)
    gain.set(gainToPos(c.gain))
    fadeIn.set(ms(c.fadeIn))
    fadeOut.set(ms(c.fadeOut))
    shape.set(String(c.fadeShape ?? 0))
    loop.set(isLooping(c))
    const track = getTracks(doc).find((t) => t.id === c.trackId)
    info.replaceChildren(
      h('div', {}, h('span', { className: 'dim' }, 'length '), `${(c.length / st.rate).toFixed(2)} s`),
      h('div', {}, h('span', { className: 'dim' }, 'gain '), fmtDb(c.gain)),
      h('div', { className: 'dim' }, `on ${track?.name ?? 'a track'}`))
    requestAnimationFrame(() => clip === c && drawWaveform(c))
  }
  return { el, update }
}
