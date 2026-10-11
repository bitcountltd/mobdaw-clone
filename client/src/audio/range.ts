// What an export covers: the audible part of the timeline.
import { clipLength, getClips, getPads, getTracks } from '@mobdaw/shared'
import type * as Y from 'yjs'

/**
 * The tracks that can be heard: not muted, and, when any track is soloed, soloed or a click track (the metronome ignores
 * solo, but its own mute counts). Soundscape source clips live in their own time, so only their pads place them on the timeline.
 */
function audibleBlocks(doc: Y.Doc, rate: number) {
  const tracks = getTracks(doc)
  const anySolo = tracks.some((t) => t.soloed)
  const audible = new Set(tracks.filter((t) => !t.muted && (!anySolo || t.soloed || t.role === 'click')).map((t) => t.id))
  const scapes = new Set(tracks.filter((t) => t.kind === 'soundscape').map((t) => t.id))
  return [
    ...getClips(doc).filter((c) => audible.has(c.trackId) && !scapes.has(c.trackId)).map((c) => ({ start: c.start, end: c.start + clipLength(c, rate) })),
    ...getPads(doc).filter((p) => audible.has(p.trackId)).map((p) => ({ start: p.start, end: p.start + p.length })),
  ]
}

/** Where the audible sound ends (samples): the end of the last clip or pad on an audible track. A looping MIDI clip counts in full. */
export const contentEnd = (doc: Y.Doc, rate: number) => Math.max(0, ...audibleBlocks(doc, rate).map((b) => b.end))

/** Where the audible sound starts (samples): the earliest clip or pad start on an audible track (0 when there is none). */
export function contentStart(doc: Y.Doc, rate: number) {
  const blocks = audibleBlocks(doc, rate)
  return blocks.length ? Math.max(0, Math.min(...blocks.map((b) => b.start))) : 0
}
