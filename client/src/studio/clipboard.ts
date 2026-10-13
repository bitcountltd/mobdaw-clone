// Arrangement edits on several clips at once, as pure functions over the doc: copy / cut / paste, duplicate, nudge, move,
// delete, and a deep copy of a whole track. Each writing function is one transaction (one undo step).
// The clipboard itself is plain data (no Yjs types), so it can outlive the selection, the clips and the open project:
// MIDI clips carry their notes, audio clips their source hash (pasted only where that audio exists).
import {
  addAudioClip, addMidiClip, addNote, clipLength, clipsMap, deleteClip, devicesMap, getClips, getDevices, getLanes, getLoopers, getNotes,
  getPads, getPoints, getSamples, getTracks, lanesMap, loopersMap, newId, orderBetween, padsMap, pointsMap, tracksMap,
  type Clip, type Note, type Track,
} from '@mobdaw/shared'
import * as Y from 'yjs'

type ClipData = Omit<Clip, 'id' | 'trackId'>
export type ClipboardItem = { clip: ClipData; trackId: string; notes: Omit<Note, 'id' | 'clipId'>[] }
export type ClipboardData = {
  items: ClipboardItem[]
  /** The earliest start among the items (samples): pasting puts this at the paste position. */
  origin: number
  /** Copied tracks in timeline order with their kinds, so a paste keeps the clips' vertical layout. */
  tracks: { id: string; kind: Track['kind'] }[]
}

const clipOf = (doc: Y.Doc, id: string) => clipsMap(doc).get(id)?.toJSON() as Clip | undefined

/** The clips `ids` (those that exist) as clipboard data; null when none do. */
export function copyClips(doc: Y.Doc, ids: string[]): ClipboardData | null {
  const clips = ids.map((id) => clipOf(doc, id)).filter((c): c is Clip => !!c)
  if (!clips.length) return null
  const notes = getNotes(doc)
  const items = clips.map(({ id, trackId, ...clip }) => ({
    clip: clip as ClipData,
    trackId,
    notes: notes.filter((n) => n.clipId === id).map(({ id: _id, clipId: _c, ...n }) => n),
  }))
  const used = new Set(clips.map((c) => c.trackId))
  const tracks = getTracks(doc).filter((t) => used.has(t.id)).map((t) => ({ id: t.id, kind: t.kind }))
  return { items, origin: Math.min(...clips.map((c) => c.start)), tracks }
}

/** Add one clip (and its notes) from clipboard data at `start` on `trackId`; returns its id. */
function placeItem(doc: Y.Doc, it: ClipboardItem, trackId: string, start: number): string {
  const id = it.clip.kind === 'audio'
    ? addAudioClip(doc, { ...it.clip, trackId, start } as Parameters<typeof addAudioClip>[1])
    : addMidiClip(doc, { ...it.clip, trackId, start } as Parameters<typeof addMidiClip>[1])
  for (const n of it.notes) addNote(doc, { ...n, clipId: id })
  return id
}

export type PasteOpts = {
  /** Where the earliest clip lands (samples). */
  at: number
  /**
   * The track the first copied track's clips go to (the others keep their distance below it). Clips whose target track
   * is missing or of another kind go back to their own track, if it still exists. Null or absent: the original tracks.
   */
  trackId?: string | null
}

/** Paste clipboard data; returns the new clip ids (one undo step). */
export function pasteClips(doc: Y.Doc, data: ClipboardData, o: PasteOpts): string[] {
  const tracks = getTracks(doc)
  const index = new Map(tracks.map((t, i) => [t.id, i]))
  const samples = getSamples(doc)
  const firstOrig = data.tracks.find((t) => index.has(t.id))
  // How many rows down the paste moves: from the first copied track (as it is now) to the target.
  const anchor = o.trackId && index.has(o.trackId) ? index.get(o.trackId)! : null
  const firstIdx = firstOrig ? index.get(firstOrig.id)! : null
  // Rows the copied tracks spanned, counted in the copied set (they may no longer exist here).
  const order = data.tracks.map((t) => t.id)
  const ids: string[] = []
  doc.transact(() => {
    for (const it of data.items) {
      if (it.clip.kind === 'audio' && !samples[(it.clip as { sourceHash: string }).sourceHash]) continue // that audio isn't in this project
      const kind = data.tracks.find((t) => t.id === it.trackId)?.kind
      let target: string | undefined
      if (anchor != null) {
        const row = firstIdx != null && index.has(it.trackId) ? index.get(it.trackId)! - firstIdx : order.indexOf(it.trackId)
        const t = tracks[anchor + row]
        if (t && t.kind === kind) target = t.id
      }
      if (!target && index.has(it.trackId)) target = it.trackId
      if (!target) continue
      ids.push(placeItem(doc, it, target, Math.max(0, Math.round(o.at + it.clip.start - data.origin))))
    }
  })
  return ids
}

/** Where the clips `ids` begin and end (samples). */
export function span(doc: Y.Doc, ids: string[], rate: number) {
  const clips = ids.map((id) => clipOf(doc, id)).filter((c): c is Clip => !!c)
  if (!clips.length) return null
  return { start: Math.min(...clips.map((c) => c.start)), end: Math.max(...clips.map((c) => c.start + clipLength(c, rate))) }
}

/** Copies of the clips `ids` on their own tracks, right after the selection's end (the whole group moves by its length). */
export function duplicateClips(doc: Y.Doc, ids: string[], rate: number): string[] {
  const data = copyClips(doc, ids)
  const s = span(doc, ids, rate)
  if (!data || !s) return []
  return pasteClips(doc, data, { at: s.end })
}

/** Move the clips `ids` by `d` samples, together (no clip goes before 0: the whole group stops there). */
export function nudgeClips(doc: Y.Doc, ids: string[], d: number) {
  const clips = ids.map((id) => clipOf(doc, id)).filter((c): c is Clip => !!c)
  if (!clips.length) return
  const dd = Math.max(d, -Math.min(...clips.map((c) => c.start)))
  if (!dd) return
  doc.transact(() => clips.forEach((c) => clipsMap(doc).get(c.id)?.set('start', c.start + Math.round(dd))))
}

export function deleteClips(doc: Y.Doc, ids: string[]) {
  doc.transact(() => ids.forEach((id) => deleteClip(doc, id)))
}

/** Cut: the clipboard data, and the clips gone (one undo step). */
export function cutClips(doc: Y.Doc, ids: string[]): ClipboardData | null {
  const data = copyClips(doc, ids)
  if (data) deleteClips(doc, ids)
  return data
}

/**
 * Move a group of clips from where they were (`from`: id -> start and track) by `d` samples and `rows` tracks down,
 * keeping their relative positions. A clip whose target row doesn't exist or is of another kind stays on its track.
 * The group never goes before 0.
 */
export function moveGroup(doc: Y.Doc, from: Map<string, { start: number; trackId: string }>, d: number, rows: number) {
  const tracks = getTracks(doc)
  const index = new Map(tracks.map((t, i) => [t.id, i]))
  const min = Math.min(...[...from.values()].map((f) => f.start))
  const dd = Math.max(d, -min)
  doc.transact(() => {
    for (const [id, f] of from) {
      const m = clipsMap(doc).get(id)
      if (!m) continue
      const i = index.get(f.trackId)
      const kind = i == null ? null : tracks[i].kind
      const to = i == null ? undefined : tracks[i + rows]
      const trackId = to && to.kind === kind ? to.id : f.trackId
      m.set('start', Math.round(f.start + dd))
      if (m.get('trackId') !== trackId) m.set('trackId', trackId)
    }
  })
}

/**
 * A deep copy of a track, right below it: its devices (with their params), clips and notes, soundscape regions and
 * loopers, and its automation lanes and points (pointed at the copies). Returns the new track's id.
 */
export function duplicateTrack(doc: Y.Doc, id: string): string | null {
  const tracks = getTracks(doc)
  const i = tracks.findIndex((t) => t.id === id)
  if (i < 0) return null
  const t = tracks[i]
  const nid = newId()
  const toMap = (o: object) => new Y.Map<unknown>(Object.entries(o))
  doc.transact(() => {
    const { id: _id, role: _role, ...rest } = t // (a copy of the click track is an ordinary track)
    tracksMap(doc).set(nid, toMap({ ...rest, id: nid, name: `${t.name} copy`, order: orderBetween(t.order, tracks[i + 1]?.order) }))
    const owners = new Map<string, string>() // old device / looper id -> new
    for (const d of getDevices(doc)) {
      if (d.trackId !== id) continue
      const did = newId()
      owners.set(d.id, did)
      const { params, ...dv } = d
      const m = toMap({ ...dv, id: did, trackId: nid })
      m.set('params', new Y.Map<number>(Object.entries(params)))
      devicesMap(doc).set(did, m)
    }
    for (const l of getLoopers(doc)) {
      if (l.trackId !== id) continue
      const lid = newId()
      owners.set(l.id, lid)
      loopersMap(doc).set(lid, toMap({ ...l, id: lid, trackId: nid }))
    }
    for (const p of getPads(doc)) {
      if (p.trackId !== id) continue
      const pid = newId()
      padsMap(doc).set(pid, toMap({ ...p, id: pid, trackId: nid }))
    }
    const data = copyClips(doc, getClips(doc).filter((c) => c.trackId === id).map((c) => c.id))
    for (const it of data?.items ?? []) placeItem(doc, it, nid, it.clip.start)
    const points = getPoints(doc)
    for (const l of getLanes(doc)) {
      if (l.scope !== id || !owners.has(l.owner)) continue
      const lid = newId()
      lanesMap(doc).set(lid, toMap({ ...l, id: lid, scope: nid, owner: owners.get(l.owner)! }))
      for (const p of points) {
        if (p.laneId !== l.id) continue
        const pid = newId()
        pointsMap(doc).set(pid, toMap({ ...p, id: pid, laneId: lid }))
      }
    }
  })
  return nid
}

/** The clip ids on the main timeline (not a soundscape's source lane, which has its own time). */
export function timelineClips(doc: Y.Doc): string[] {
  const scapes = new Set(getTracks(doc).filter((t) => t.kind === 'soundscape').map((t) => t.id))
  return getClips(doc).filter((c) => !scapes.has(c.trackId)).map((c) => c.id)
}

// --- the clipboard (this tab)
let board: ClipboardData | null = null
export const clipboard = {
  get: () => board,
  set: (d: ClipboardData | null) => void (d && (board = d)),
}
