// Song markers: named positions that split the song into sections (intro, verse, chorus…), for arranging.
//   markers  Y.Map  id -> Y.Map Marker { id, pos (timeline samples), name, color? (index into TRACK_COLORS) }
// A section runs from its marker to the next one (the last to the song's end). A flat map keyed by id, like the rest of
// the schema, so two people can add, move and rename markers at the same time; it is in the undo scope, and
// `setProjectTempo` keeps every marker on its bar. Old projects have none.
import * as Y from 'yjs'
import { newId } from './schema.ts'

export type Marker = { id: string; pos: number; name: string; color?: number }
type YM = Y.Map<unknown>

export const markersMap = (doc: Y.Doc) => doc.getMap<YM>('markers')

/** The markers in song order (by position, then id so concurrent ones at the same spot keep a stable order). */
export function getMarkers(doc: Y.Doc): Marker[] {
  return [...markersMap(doc).values()].map((m) => m.toJSON() as Marker).sort(byPos)
}
const byPos = (a: Marker, b: Marker) => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export const MARKER_NAME_MAX = 40
const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MARKER_NAME_MAX)

export function addMarker(doc: Y.Doc, m: Pick<Marker, 'pos' | 'name'> & { color?: number }): string {
  const id = newId()
  const o: Marker = { id, pos: Math.max(0, Math.round(m.pos)), name: cleanName(m.name) || 'Section', ...(m.color != null ? { color: m.color } : {}) }
  doc.transact(() => markersMap(doc).set(id, new Y.Map<unknown>(Object.entries(o))))
  return id
}

/** Move, rename or recolour a marker (`color: null` takes its colour off). An empty name is ignored. */
export function updateMarker(doc: Y.Doc, id: string, patch: { pos?: number; name?: string; color?: number | null }) {
  const m = markersMap(doc).get(id)
  if (!m) return
  doc.transact(() => {
    if (patch.pos != null) {
      const pos = Math.max(0, Math.round(patch.pos))
      if (m.get('pos') !== pos) m.set('pos', pos)
    }
    if (patch.name != null) {
      const name = cleanName(patch.name)
      if (name && m.get('name') !== name) m.set('name', name)
    }
    if (patch.color === null) m.delete('color')
    else if (patch.color != null) m.set('color', patch.color)
  })
}

export const deleteMarker = (doc: Y.Doc, id: string) => doc.transact(() => markersMap(doc).delete(id))

// --- sections (pure: take the sorted list from getMarkers)

/** Names new markers take in turn; once all are used, "Section n". */
export const MARKER_NAMES = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'] as const

/** The name for the next marker: the first of MARKER_NAMES not used yet, else "Section n" (n = how many there would be). */
export function nextMarkerName(markers: Pick<Marker, 'name'>[]): string {
  const used = new Set(markers.map((m) => m.name.toLowerCase()))
  const free = MARKER_NAMES.find((n) => !used.has(n.toLowerCase()))
  if (free) return free
  for (let n = markers.length + 1; ; n++) if (!used.has(`section ${n}`)) return `Section ${n}`
}

/** The index of the section `pos` is in: the last marker at or before it (-1 before the first marker). */
export function sectionIndexAt(markers: Pick<Marker, 'pos'>[], pos: number): number {
  let i = -1
  for (let k = 0; k < markers.length && markers[k].pos <= pos; k++) i = k
  return i
}

/** The marker whose section contains `pos`, or null before the first marker. */
export function sectionAt<M extends Pick<Marker, 'pos'>>(markers: M[], pos: number): M | null {
  const i = sectionIndexAt(markers, pos)
  return i < 0 ? null : markers[i]
}

/** Where section `i` runs: from its marker to the next marker, the last one to `songEnd` (at least `minLen` samples long). */
export function sectionRange(markers: Pick<Marker, 'pos'>[], i: number, songEnd: number, minLen = 1): { start: number; end: number } {
  const start = markers[i].pos
  const next = markers.slice(i + 1).find((m) => m.pos > start)
  // the last section runs to the song's end, but at least `minLen` (callers pass 4 bars) for a marker at or past it
  return { start, end: next ? next.pos : Math.max(songEnd, start + Math.max(1, minLen)) }
}

/**
 * The marker to jump to from `pos`: the next one after it (dir 1), or the previous one (dir -1). Going back from just
 * after a marker (within `grace` samples, e.g. while playing) skips it, so pressing again keeps moving.
 */
export function markerJump<M extends Pick<Marker, 'pos'>>(markers: M[], pos: number, dir: 1 | -1, grace = 0): M | null {
  if (dir > 0) return markers.find((m) => m.pos > pos + 0.5) ?? null
  for (let k = markers.length - 1; k >= 0; k--) if (markers[k].pos < pos - 0.5 - grace) return markers[k]
  return null
}
