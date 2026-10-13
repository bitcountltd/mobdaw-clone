// Project tempo, meter, musical grid, loop region and track colours (redesign, docs/redesign.md §4).
//   meta.bpm          number   project tempo (absent on old projects: see `getTempo`)
//   meta.beatsPerBar  number   time signature numerator (the beat is a quarter note)
//   meta.loop         plain object { start, end, on } in timeline samples: the transport's cycle region
//   Track.color       number   index into TRACK_COLORS (absent: derived from the track's order)
// Timeline positions stay in samples. The tempo only drives the ruler, the snap grid, new MIDI clips and the click.
// Changing the tempo (`setProjectTempo`) moves everything so it stays on the same bar and beat.
import * as Y from 'yjs'
import { DEFAULT_MIDI_BPM, clipsMap, getClips, getPads, getPoints, getSampleRate, getTracks, metaMap, padsMap, pointsMap, tracksMap, type Track } from './schema.ts'

export type Tempo = { bpm: number; beatsPerBar: number }
export type LoopRegion = { start: number; end: number; on: boolean }
export const BPM_MIN = 30
export const BPM_MAX = 300
export const DEFAULT_BEATS_PER_BAR = 4

/** The project's tempo. Old projects have no `meta.bpm`: they take the click track's clip tempo, else the first MIDI clip's, else 120. */
export function getTempo(doc: Y.Doc): Tempo {
  const meta = metaMap(doc)
  let bpm = meta.get('bpm') as number | undefined
  if (bpm == null) {
    const click = getTracks(doc).find((t) => t.role === 'click')
    const midi = getClips(doc).filter((c) => c.kind === 'midi')
    const c = (click && midi.find((m) => m.trackId === click.id)) ?? midi[0]
    bpm = c?.kind === 'midi' ? c.bpm : DEFAULT_MIDI_BPM
  }
  return { bpm, beatsPerBar: (meta.get('beatsPerBar') as number | undefined) ?? DEFAULT_BEATS_PER_BAR }
}

export const samplesPerBeat = (bpm: number, rate: number) => (60 * rate) / bpm
export const samplesPerBar = (t: Tempo, rate: number) => samplesPerBeat(t.bpm, rate) * t.beatsPerBar

/** Bar (from 1), beat in bar (from 1) and sixteenth in beat (from 1) at timeline sample `pos`. */
export function barsBeats(pos: number, t: Tempo, rate: number): { bar: number; beat: number; sixteenth: number } {
  const beats = pos / samplesPerBeat(t.bpm, rate)
  const whole = Math.floor(beats + 1e-9)
  return {
    bar: Math.floor(whole / t.beatsPerBar) + 1,
    beat: (whole % t.beatsPerBar) + 1,
    sixteenth: Math.floor((beats - whole) * 4 + 1e-9) + 1,
  }
}
export const formatBarsBeats = (pos: number, t: Tempo, rate: number) => {
  const b = barsBeats(Math.max(0, pos), t, rate)
  return `${b.bar}.${b.beat}.${b.sixteenth}`
}

/**
 * Snap grid sizes, in beats. 0 is off. 'bar' snaps to whole bars whatever the meter. Labels are what the UI shows.
 */
export type GridSize = 0 | 'bar' | 1 | 0.5 | 0.25 | 0.125
export const GRID_SIZES: { value: GridSize; label: string }[] = [
  { value: 0, label: 'off' },
  { value: 'bar', label: 'bar' },
  { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' },
  { value: 0.25, label: '1/16' },
  { value: 0.125, label: '1/32' },
]
export const gridSamples = (g: GridSize, t: Tempo, rate: number) =>
  g === 0 ? 0 : g === 'bar' ? samplesPerBar(t, rate) : samplesPerBeat(t.bpm, rate) * g

/** Round timeline sample `pos` to the nearest grid line (unchanged when the grid is off). */
export function snapToGrid(pos: number, g: GridSize, t: Tempo, rate: number): number {
  const step = gridSamples(g, t, rate)
  if (!step) return Math.round(pos)
  return Math.max(0, Math.round(Math.round(pos / step) * step))
}

/**
 * A grid size that keeps grid lines at least `minPx` apart at `pps` pixels per second: what the ruler and the lanes draw
 * when zoomed out (and what 'auto' snapping uses). Returns beats (may be several bars, e.g. 16).
 */
export function visibleGridBeats(t: Tempo, pps: number, minPx = 14): number {
  const beatPx = (60 / t.bpm) * pps
  const steps = [0.125, 0.25, 0.5, 1, ...[1, 2, 4, 8, 16, 32, 64, 128].map((n) => n * t.beatsPerBar)]
  return steps.find((b) => b * beatPx >= minPx) ?? steps[steps.length - 1]
}

export function getLoop(doc: Y.Doc): LoopRegion | null {
  const l = metaMap(doc).get('loop') as LoopRegion | undefined
  return l && l.end > l.start ? l : null
}
export function setLoop(doc: Y.Doc, l: LoopRegion | null) {
  doc.transact(() => (l ? metaMap(doc).set('loop', { start: Math.max(0, Math.round(l.start)), end: Math.round(l.end), on: l.on }) : metaMap(doc).delete('loop')))
}

/**
 * Set the project tempo. Everything on the timeline keeps its bar and beat: clip and pad starts, automation points and
 * the loop region are scaled by old/new; MIDI clips take the new bpm (their notes are in ticks, so they follow); audio
 * clips keep their length (audio is not stretched). One transaction, so one undo step.
 */
export function setProjectTempo(doc: Y.Doc, bpm: number) {
  const next = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 100) / 100))
  const prev = getTempo(doc).bpm
  if (next === prev && metaMap(doc).get('bpm') != null) return
  const k = prev / next
  doc.transact(() => {
    const clips = clipsMap(doc)
    for (const c of getClips(doc)) {
      const m = clips.get(c.id)!
      m.set('start', Math.round(c.start * k))
      if (c.kind === 'midi') m.set('bpm', next)
    }
    for (const p of getPads(doc)) {
      const m = padsMap(doc).get(p.id)!
      m.set('start', Math.round(p.start * k))
      m.set('length', Math.max(1, Math.round(p.length * k)))
    }
    for (const p of getPoints(doc)) pointsMap(doc).get(p.id)!.set('pos', Math.round(p.pos * k))
    const loop = getLoop(doc)
    if (loop) setLoop(doc, { ...loop, start: loop.start * k, end: loop.end * k })
    metaMap(doc).set('bpm', next)
  })
}
export function setBeatsPerBar(doc: Y.Doc, n: number) {
  metaMap(doc).set('beatsPerBar', Math.min(12, Math.max(1, Math.round(n))))
}

/** Track colours: muted cassette-label hues that read on the dark console. Index stored on `Track.color`. */
export const TRACK_COLORS = ['#58b4a8', '#6c9bd6', '#a68bd9', '#d97c9e', '#d9a648', '#8db86b', '#e0896a', '#8e9cb0'] as const
export const trackColor = (t: Pick<Track, 'order'> & { color?: number }, index = 0) =>
  TRACK_COLORS[(((t.color ?? index) % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length]
export const setTrackColor = (doc: Y.Doc, id: string, color: number) => tracksMap(doc).get(id)?.set('color', color)
/** The project sample rate, re-exported for callers that only import tempo helpers. */
export { getSampleRate }
