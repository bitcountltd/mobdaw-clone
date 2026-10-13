// The drum grid for one MIDI clip: the same notes as the piano roll, a row per drum (an instrument on a single key) and
// a cell per step. Notes on keys with no drum row are kept, just not shown.
//
//   click an empty cell     add a hit (drag along the row to add more)
//   click a hit             remove it          drag a hit up / down    its velocity
//   alt + click a hit       cycle its velocity: full, ¾, ½, ¼
//   click a drum's name     hear it
import { DEVICES, KEY_MIN, addDrum, addNote, deleteNote, isDrum, isLooping, patternTicks, updateNote, type Device, type MidiClip, type Note } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { clampVelocity, nextVelocity } from '../studio/dock/noteOps'
import { dragPointer } from './blocks'
import { noteName } from './noteName'

const NAMES_W = 132
const ROW_H = 26

export type DrumGridDeps = {
  doc: Y.Doc
  undo: Y.UndoManager
  readOnly: boolean
  /** The snap step in ticks for this clip (0: off); the grid uses a 1/16 when it is off or coarser than a beat. */
  step(c: MidiClip): number
  beatsPerBar(): number
  noteLive?(trackId: string, pitch: number, velocity: number, on: boolean): void
  status?(text: string): void
}
export type DrumView = { tc: string; pps: number; extent: number }

export function drumGrid(deps: DrumGridDeps) {
  const { doc, undo, readOnly } = deps
  let clip: MidiClip | null = null
  let notes: Note[] = []
  let pxBeat = 48
  let extent = 0
  let stepT = 240

  const names = h('div', { className: 'dg-names' })
  const cells = h('div', { className: 'dg-cells' })
  const playhead = h('div', { className: 'pr-playhead', hidden: true })
  const inner = h('div', { className: 'dg-inner' }, names, cells)
  const scroll = h('div', { className: 'dg-scroll' }, inner)
  const el = h('div', { className: 'dg', tabIndex: 0 }, scroll)
  el.style.setProperty('--names-w', `${NAMES_W}px`)
  el.style.setProperty('--row-h', `${ROW_H}px`)

  const px = (ticks: number) => (ticks / clip!.ppq) * pxBeat

  /** The pattern step under the pointer in a row (a repeat's cell is its pattern's), or null past the end. */
  function stepAt(e: { clientX: number }, row: HTMLElement): number | null {
    const c = clip!
    const pattern = patternTicks(c)
    const at = Math.floor((((e.clientX - row.getBoundingClientRect().left) / pxBeat) * c.ppq) / stepT) * stepT
    if (at < 0 || at >= extent) return null
    const tick = at % pattern
    return tick + stepT > pattern + 1e-6 ? null : tick
  }
  const hitsAt = (pitch: number, tick: number) => notes.filter((n) => n.pitch === pitch && n.tick >= tick && n.tick < tick + stepT)

  function press(e: PointerEvent, row: HTMLElement, pitch: number) {
    e.stopPropagation()
    el.focus({ preventScroll: true })
    if (readOnly || e.button !== 0 || !clip) return
    const c = clip
    const tick = stepAt(e, row)
    if (tick == null) return
    e.preventDefault()
    const here = hitsAt(pitch, tick)
    undo.stopCapturing()
    if (here.length && e.altKey) { // cycle the velocity
      const v = nextVelocity(here[0].velocity)
      doc.transact(() => here.forEach((n) => updateNote(doc, n.id, { velocity: v })))
      deps.status?.(`velocity ${Math.round(v * 127)}`)
      undo.stopCapturing()
      return
    }
    if (here.length) { // drag up / down for velocity; a plain click removes it
      const v0 = here[0].velocity
      let moved = false
      dragPointer(e, {
        onDrag: (m) => {
          const dy = e.clientY - m.clientY
          if (!moved && Math.abs(dy) < 3) return
          moved = true
          const v = clampVelocity(v0 + dy / 90)
          doc.transact(() => here.forEach((n) => updateNote(doc, n.id, { velocity: v })))
          deps.status?.(`velocity ${Math.round(v * 127)}`)
        },
        onEnd: () => {
          if (!moved) doc.transact(() => here.forEach((n) => deleteNote(doc, n.id)))
          undo.stopCapturing()
        },
      })
      return
    }
    // add, and keep adding along the row while dragging
    const added = new Set<number>([tick])
    addNote(doc, { clipId: c.id, tick, durTicks: stepT, pitch, velocity: 1 })
    deps.noteLive?.(c.trackId, pitch, 1, true)
    setTimeout(() => deps.noteLive?.(c.trackId, pitch, 1, false), 120)
    dragPointer(e, {
      onDrag: (m) => {
        const t = stepAt(m, row)
        if (t == null || added.has(t)) return
        added.add(t)
        if (!hitsAt(pitch, t).length) addNote(doc, { clipId: c.id, tick: t, durTicks: stepT, pitch, velocity: 1 })
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  function audition(e: PointerEvent, pitch: number, pad: HTMLElement) {
    if (e.button !== 0 || !clip) return
    e.preventDefault()
    const c = clip
    pad.classList.add('down')
    deps.noteLive?.(c.trackId, pitch, 1, true)
    const up = () => {
      pad.classList.remove('down')
      deps.noteLive?.(c.trackId, pitch, 1, false)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  function update(c: MidiClip, list: Note[], instruments: Device[], view: DrumView) {
    clip = c
    extent = view.extent
    notes = list
    pxBeat = (view.pps * 60) / c.bpm
    const s = deps.step(c)
    stepT = s && s <= c.ppq ? s : c.ppq / 4
    const bpb = deps.beatsPerBar()
    const pattern = patternTicks(c)
    const looping = isLooping(c)
    el.style.setProperty('--tc', view.tc)
    cells.style.setProperty('--step', `${px(stepT)}px`)
    cells.style.setProperty('--beat', `${pxBeat}px`)
    cells.style.setProperty('--bar', `${pxBeat * bpb}px`)
    cells.classList.toggle('fine', px(stepT) < 9)
    const w = px(extent)
    cells.style.width = `${w}px`

    // a row per drum, in the chain's order (a wide-range instrument has none)
    const drums = instruments.filter(isDrum)
    const nameRows: HTMLElement[] = []
    const rows = drums.map((d) => {
      const key = d.keyLo ?? KEY_MIN
      const label = d.name ?? DEVICES[d.type]?.name ?? 'drum'
      const pad = h('div', { className: 'dg-name', title: `${label}: click to hear it` }, h('i', { className: 'dg-led' }), h('span', { className: 'dg-drum' }, label), h('span', { className: 'dg-key' }, noteName(key)))
      if (d.bypass) pad.classList.add('off')
      pad.onpointerdown = (e) => audition(e, key, pad)
      nameRows.push(pad)
      const row = h('div', { className: 'dg-row' })
      row.onpointerdown = (e) => press(e, row, key)
      const passes = looping ? Math.ceil(extent / pattern) : 1
      for (const n of notes) {
        if (n.pitch !== key || n.tick < 0 || n.tick >= pattern) continue
        for (let k = 0; k < passes; k++) {
          const tick = k * pattern + Math.floor(n.tick / stepT) * stepT
          if (tick >= extent) break
          const hit = h('i', { className: k ? 'dg-hit rep' : 'dg-hit' })
          hit.style.left = `${px(tick) + 1}px`
          hit.style.width = `${Math.max(2, px(stepT) - 3)}px`
          hit.style.setProperty('--v', String(n.velocity))
          row.append(hit)
        }
      }
      if (looping) {
        const rep = h('i', { className: 'dg-rep' }) // the repeats: shaded, and not a place of their own
        rep.style.left = `${px(pattern)}px`
        row.append(rep)
      }
      return row
    })
    const add = h('button', { className: 'dg-add', title: 'add a lofi drum on the next free key', disabled: readOnly, onclick: () => addDrum(doc, c.trackId) }, '+ add drum')
    add.onpointerdown = (e) => e.stopPropagation()
    const empty = drums.length ? null : h('div', { className: 'dg-empty' }, 'This track has no drums yet. Add one, or load a kit from the devices tab.')
    names.replaceChildren(...nameRows, add)
    cells.replaceChildren(...rows, ...(empty ? [empty] : []), playhead)
  }
  function setPlayhead(tick: number | null) {
    const on = tick != null && clip != null && tick >= 0 && tick < extent
    playhead.hidden = !on
    if (on) playhead.style.transform = `translateX(${px(tick!)}px)`
  }
  const reset = () => {}
  return { el, scroller: scroll, keysWidth: NAMES_W, update, reset, setPlayhead }
}
