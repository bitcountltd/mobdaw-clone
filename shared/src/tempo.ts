// Project tempo, meter, musical grid, loop region and track colours (redesign, docs/redesign.md §4).
//   meta.bpm          number   project tempo (absent on old projects: see `getTempo`)
//   meta.beatsPerBar  number   time signature numerator (the beat is a quarter note)
//   meta.loop         plain object { start, end, on } in timeline samples: the transport's cycle region
//   Track.color       number   index into TRACK_COLORS (absent: derived from the track's order)
// Timeline positions stay in samples. The tempo only drives the ruler, the snap grid, new MIDI clips and the click.
// Changing the tempo (`setProjectTempo`) moves everything so it stays on the same bar and beat.
import * as Y from 'yjs'
import { markersMap, getMarkers } from './markers.ts'
import { DEFAULT_MIDI_BPM, addNote, clipsMap, getClips, getNotes, getPads, getPoints, getSampleRate, getTracks, metaMap, notesMap, padsMap, pointsMap, tracksMap, type Track } from './schema.ts'

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
  // positions are whole samples, so one on a beat (or sixteenth) can land a fraction of a sample short of it when a
  // beat isn't a whole number of samples (e.g. 88 bpm): allow ~1e-4 beat, so it still counts as that beat
  const whole = Math.floor(beats + 1e-4)
  return {
    bar: Math.floor(whole / t.beatsPerBar) + 1,
    beat: (whole % t.beatsPerBar) + 1,
    sixteenth: Math.min(4, Math.max(0, Math.floor((beats - whole) * 4 + 1e-4)) + 1),
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
 * Set the project tempo. Everything on the timeline keeps its bar and beat: clip and pad starts, automation points, song
 * markers and the loop region are scaled by old/new; MIDI clips take the new bpm (their notes are in ticks, so they follow); audio
 * clips keep their length (audio is not stretched). One transaction, so one undo step.
 */
export function setProjectTempo(doc: Y.Doc, bpm: number) {
  beginTempoChange(doc).set(bpm)
}

/** Clamp and round a bpm the way the project stores it. */
export const clampBpm = (bpm: number) => Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 100) / 100))

/**
 * A tempo change in steps (a drag on the tempo field): the positions are captured once, when it begins, and every
 * `set(bpm)` scales them from that snapshot, so going back and forth never drifts (each step rounding the last one's
 * rounded values would). `end()` lets go of the snapshot; things added meanwhile are left alone until the next change.
 */
export function beginTempoChange(doc: Y.Doc): { set(bpm: number): void; end(): void } {
  const base = getTempo(doc).bpm
  const clips = getClips(doc).map((c) => ({ id: c.id, start: c.start, midi: c.kind === 'midi' }))
  const pads = getPads(doc).map((p) => ({ id: p.id, start: p.start, length: p.length }))
  const points = getPoints(doc).map((p) => ({ id: p.id, pos: p.pos }))
  const markers = getMarkers(doc).map((m) => ({ id: m.id, pos: m.pos }))
  const loop = getLoop(doc)
  let done = false
  return {
    set(bpm: number) {
      if (done) return
      const next = clampBpm(bpm)
      if (next === getTempo(doc).bpm && metaMap(doc).get('bpm') != null) return
      const k = base / next
      doc.transact(() => {
        for (const c of clips) {
          const m = clipsMap(doc).get(c.id)
          if (!m) continue
          const start = Math.round(c.start * k)
          if (m.get('start') !== start) m.set('start', start)
          if (c.midi && m.get('bpm') !== next) m.set('bpm', next)
        }
        for (const p of pads) {
          const m = padsMap(doc).get(p.id)
          if (!m) continue
          m.set('start', Math.round(p.start * k))
          m.set('length', Math.max(1, Math.round(p.length * k)))
        }
        for (const p of points) pointsMap(doc).get(p.id)?.set('pos', Math.round(p.pos * k))
        for (const m of markers) markersMap(doc).get(m.id)?.set('pos', Math.round(m.pos * k))
        if (loop && getLoop(doc)) setLoop(doc, { ...getLoop(doc)!, start: loop.start * k, end: loop.end * k })
        metaMap(doc).set('bpm', next)
      })
    },
    end() { done = true },
  }
}
export function setBeatsPerBar(doc: Y.Doc, n: number) {
  doc.transact(() => {
    metaMap(doc).set('beatsPerBar', Math.min(12, Math.max(1, Math.round(n))))
    fitClickTrack(doc)
  })
}

/**
 * Make the click track (role 'click') follow the project: its clips take the project bpm, and its one-bar pattern is
 * rewritten for the meter (an accent on the downbeat, a tick on every beat). Only touches a pattern that looks like a
 * click (the notes the click track was made with); a hand-edited one keeps its notes and just gets the new bar length.
 */
export function fitClickTrack(doc: Y.Doc) {
  const click = getTracks(doc).find((t) => t.role === 'click')
  if (!click) return
  const { bpm, beatsPerBar } = getTempo(doc)
  doc.transact(() => {
    for (const c of getClips(doc)) {
      if (c.trackId !== click.id || c.kind !== 'midi') continue
      const m = clipsMap(doc).get(c.id)!
      if (c.bpm !== bpm) m.set('bpm', bpm)
      const bar = beatsPerBar * c.ppq
      if (c.loopTicks === bar) continue
      const notes = getNotes(doc).filter((x) => x.clipId === c.id)
      const pitches = [...new Set(notes.map((x) => x.pitch))]
      const plain = notes.every((x) => x.tick % c.ppq === 0) && pitches.length <= 2
      m.set('loopTicks', bar)
      if (c.lengthTicks < bar) m.set('lengthTicks', bar)
      if (!plain || !notes.length) continue
      const tick = notes.find((x) => x.tick > 0)?.pitch ?? notes[0].pitch
      const accent = pitches.find((p) => p !== tick)
      const dur = notes[0].durTicks
      for (const x of notes) notesMap(doc).delete(x.id)
      for (let b = 0; b < beatsPerBar; b++) addNote(doc, { clipId: c.id, tick: b * c.ppq, durTicks: dur, pitch: tick, velocity: 1 })
      if (accent != null) addNote(doc, { clipId: c.id, tick: 0, durTicks: dur, pitch: accent, velocity: 1 })
    }
  })
}

// --- loop region helpers (pure)

/** The bar containing `pos` (from 0) and its start, in samples. */
export function barAt(pos: number, t: Tempo, rate: number) {
  const bar = samplesPerBar(t, rate)
  const i = Math.max(0, Math.floor(pos / bar + 1e-9))
  return { index: i, start: Math.round(i * bar) }
}

/** A loop over the `bars`-bar phrase around `pos` (phrases start at bars 1, 5, 9… for 4 bars). */
export function loopAround(pos: number, t: Tempo, rate: number, bars = 4): LoopRegion {
  const bar = samplesPerBar(t, rate)
  const i = Math.floor(Math.max(0, pos) / bar / bars + 1e-9) * bars
  return { start: Math.round(i * bar), end: Math.round((i + bars) * bar), on: true }
}

/**
 * What the loop toggle (L) does: switch an existing region on or off; with none, make one over `range` (the selection,
 * stretched out to whole grid steps of `step` samples when given) or else the 4 bars around `pos`, switched on.
 */
export function toggledLoop(cur: LoopRegion | null, pos: number, t: Tempo, rate: number, range?: { start: number; end: number } | null, step = 0): LoopRegion {
  if (cur) return { ...cur, on: !cur.on }
  if (range && range.end > range.start) {
    const s = step > 0 ? Math.floor(range.start / step + 1e-9) * step : range.start
    const e = step > 0 ? Math.ceil(range.end / step - 1e-9) * step : range.end
    return { start: Math.round(s), end: Math.round(e), on: true }
  }
  return loopAround(pos, t, rate)
}

/** A region dragged between two points `a` and `b` (either order), at least `min` samples long. */
export function loopBetween(a: number, b: number, min: number, on = true): LoopRegion {
  const start = Math.max(0, Math.min(a, b))
  return { start: Math.round(start), end: Math.round(Math.max(Math.max(a, b), start + min)), on }
}

/** Tap tempo: the bpm from tap times (ms, oldest first), or null with fewer than 2 taps. Uses the recent taps only. */
export function tapBpm(times: number[]): number | null {
  const recent = times.slice(-6)
  if (recent.length < 2) return null
  const gap = (recent[recent.length - 1] - recent[0]) / (recent.length - 1)
  if (!(gap > 0)) return null
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round((60000 / gap) * 10) / 10))
}

/** Track colours: muted cassette-label hues that read on the dark console. Index stored on `Track.color`. */
export const TRACK_COLORS = ['#58b4a8', '#6c9bd6', '#a68bd9', '#d97c9e', '#d9a648', '#8db86b', '#e0896a', '#8e9cb0'] as const
export const trackColor = (t: Pick<Track, 'order'> & { color?: number }, index = 0) =>
  TRACK_COLORS[(((t.color ?? index) % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length]
export const setTrackColor = (doc: Y.Doc, id: string, color: number) => tracksMap(doc).get(id)?.set('color', color)
/** The project sample rate, re-exported for callers that only import tempo helpers. */
export { getSampleRate }
