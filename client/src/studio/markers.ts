// Song markers in the studio: adding one (at the playhead or a ruler position), jumping between them, looping a section,
// and the section the playhead is in (the top bar shows its name). The data and the pure section math live in
// shared/src/markers.ts; the ruler (arrange/ruler.ts) draws the flags and handles the pointer.
import {
  addMarker, clipLength, getClips, getMarkers, getPads, getTracks, isForever, markerJump, nextMarkerName, patternTicks, samplesPerBar,
  sectionAt, sectionIndexAt, sectionRange, setLoop, snapToGrid, type Marker,
} from '@mobdaw/shared'
import { h } from '../dom'
import type { Studio } from './studio'
import type { KeyBinding } from './keys'
import './markers.css'

/** Where the song's content ends (samples): the last clip or region, out to a whole bar; at least 4 bars. */
export function songEnd(st: Studio): number {
  const scapes = new Set(getTracks(st.doc).filter((t) => t.kind === 'soundscape').map((t) => t.id))
  const ends = getClips(st.doc).filter((c) => !scapes.has(c.trackId)).map((c) => {
    if (!isForever(c)) return c.start + clipLength(c, st.rate)
    return c.start + (c.kind === 'midi' ? (patternTicks(c) / c.ppq) * (60 / c.bpm) * st.rate : clipLength(c, st.rate))
  })
  const bar = samplesPerBar(st.tempo(), st.rate)
  const end = Math.max(4 * bar, ...ends, ...getPads(st.doc).map((p) => p.start + p.length))
  return Math.round(Math.ceil(end / bar - 1e-6) * bar)
}

/** A marker position: on the nearest bar, or exactly `pos` when `free` (alt held). */
export const markerPos = (st: Studio, pos: number, free = false) =>
  free ? Math.max(0, Math.round(pos)) : snapToGrid(pos, 'bar', st.tempo(), st.rate)

/**
 * Add a marker at `pos` (snapped to the bar unless `free`), named the next of Intro, Verse, Chorus… Returns its id, or
 * the id of the marker already there (no duplicates on one spot). Its own undo step.
 */
export function insertMarker(st: Studio, pos: number, free = false): { id: string; added: boolean } | null {
  if (st.readOnly) return null
  const at = markerPos(st, pos, free)
  const markers = getMarkers(st.doc)
  const there = markers.find((m) => Math.abs(m.pos - at) < 1)
  if (there) return { id: there.id, added: false }
  st.undo.stopCapturing()
  const id = addMarker(st.doc, { pos: at, name: nextMarkerName(markers) })
  st.undo.stopCapturing()
  return { id, added: true }
}

/** Move the playhead to the next (dir 1) or previous (-1) marker; before the first, back to the start. */
export function jumpMarker(st: Studio, dir: 1 | -1) {
  const markers = getMarkers(st.doc)
  const p = st.position()
  // while playing, "previous" from just past a marker goes to the one before it (half a second of grace)
  const m = markerJump(markers, p, dir, st.playing ? 0.5 * st.rate : 0)
  if (m) return st.seek(m.pos)
  if (dir < 0 && p > 0) st.seek(0)
}

/** The shortest last section (a marker at or past the song's end still makes a usable section): 4 bars. */
export const sectionMinLen = (st: Studio) => Math.round(4 * samplesPerBar(st.tempo(), st.rate))

/** The loop region over a marker's section: to the next marker, or the song's end for the last one. Switched on. */
export function loopSection(st: Studio, id: string) {
  if (st.readOnly) return
  const markers = getMarkers(st.doc)
  const i = markers.findIndex((m) => m.id === id)
  if (i < 0) return
  const r = sectionRange(markers, i, songEnd(st), sectionMinLen(st))
  st.undo.stopCapturing()
  setLoop(st.doc, { start: r.start, end: r.end, on: true })
  st.undo.stopCapturing()
  st.status(`looping ${markers[i].name}`)
}

/** The section the position is in (null before the first marker or with none). */
export const currentSection = (st: Studio, pos = st.position()): Marker | null => sectionAt(getMarkers(st.doc), pos)
export { sectionIndexAt }

/**
 * The marker shortcuts: I adds a marker at the playhead (`onAdded` gets its id, e.g. to rename it in place), [ and ]
 * jump to the previous / next one.
 */
export function markerKeys(st: Studio, onAdded?: (id: string) => void): KeyBinding[] {
  const insert = (free: boolean) => {
    const r = insertMarker(st, st.position(), free)
    if (r?.added) onAdded?.(r.id)
    else if (r) st.status('there is a marker on this bar already')
  }
  return [
    { key: 'i', run: () => insert(false), label: 'insert a marker at the playhead (on the bar)', group: 'Editing' },
    { key: 'i', mods: { alt: true }, run: () => insert(true), label: 'insert a marker exactly at the playhead', group: 'Editing' },
    { key: '[', run: () => jumpMarker(st, -1), label: 'previous marker', group: 'Transport', readOnly: true, repeat: true },
    { key: ']', run: () => jumpMarker(st, 1), label: 'next marker', group: 'Transport', readOnly: true, repeat: true },
  ]
}

/**
 * The name of the section the playhead is in, small beside the top bar's counter: dim when stopped, lit while playing.
 * Hidden in a song without markers. It keeps one width (from the longest name, up to 10ch) so the bar never shifts.
 */
export function mountSectionLabel(st: Studio) {
  const el = h('span', { className: 'tb-section', 'aria-live': 'off', 'data-hint': 'the song section the playhead is in ([ / ]: previous / next marker)' })
  let markers = getMarkers(st.doc)
  let last: string | null = null
  const draw = (p = st.position()) => {
    const m = sectionAt(markers, p)
    const name = m?.name ?? ''
    if (name !== last) {
      last = name
      el.textContent = name
      el.title = name
    }
  }
  const doc = () => {
    markers = getMarkers(st.doc)
    el.hidden = !markers.length
    el.style.width = `${Math.min(10, Math.max(4, ...markers.map((m) => m.name.length))) * 0.62 + 0.4}em`
    last = null
    draw()
  }
  const transport = () => (el.classList.toggle('playing', st.playing), draw())
  const offs = [st.on('doc', doc), st.on('tick', draw), st.on('transport', transport)]
  doc()
  transport()
  return { el, destroy: () => offs.forEach((f) => f()) }
}
