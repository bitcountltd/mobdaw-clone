// Pure note edits shared by the piano roll, the drum grid and their tests: grid steps in ticks, quantize, transpose,
// velocity, and the notes inside a marquee. Nothing here touches the doc: each returns the patches to write.
import type { GridSize, Note } from '@mobdaw/shared'

export type NotePatch = { id: string; tick?: number; durTicks?: number; pitch?: number; velocity?: number }
export const PITCH_MIN = 12 // c0
export const PITCH_MAX = 108 // c8
export const VEL_MIN = 0.05

/** The editor's own grid: follow the studio's snap, or one of the grid sizes. */
export type EditorGrid = 'studio' | GridSize

/** A grid size as ticks (0: off). `beatsPerBar` is the project meter. */
export function gridTicks(g: GridSize, ppq: number, beatsPerBar: number): number {
  if (g === 0) return 0
  if (g === 'bar') return ppq * beatsPerBar
  return Math.max(1, Math.round(ppq * g))
}

/** Round a tick to the grid (`step` 0: unchanged, apart from rounding to a whole tick). */
export const snapTick = (tick: number, step: number) => (step > 0 ? Math.round(tick / step) * step : Math.round(tick))
/** The grid line at or before a tick. */
export const floorTick = (tick: number, step: number) => (step > 0 ? Math.floor(tick / step) * step : Math.floor(tick))

/**
 * Quantize notes to the grid: each start moves `strength` (0..1) of the way to its nearest line. A note's end keeps its
 * length, except that a length under a step becomes at least one step when `lengths` is set. Notes already on the grid
 * give no patch.
 */
export function quantize(notes: Note[], step: number, strength = 1, lengths = false): NotePatch[] {
  if (!(step > 0)) return []
  const out: NotePatch[] = []
  for (const n of notes) {
    const target = Math.max(0, snapTick(n.tick, step))
    const tick = Math.round(n.tick + (target - n.tick) * Math.min(1, Math.max(0, strength)))
    const dur = lengths ? Math.max(step, snapTick(n.durTicks, step)) : n.durTicks
    if (tick !== n.tick || dur !== n.durTicks) out.push({ id: n.id, ...(tick !== n.tick ? { tick } : {}), ...(dur !== n.durTicks ? { durTicks: dur } : {}) })
  }
  return out
}

/** Move notes by `semis` semitones. If any would leave the playable range the whole move is refused (null). */
export function transpose(notes: Note[], semis: number, lo = PITCH_MIN, hi = PITCH_MAX): NotePatch[] | null {
  if (!semis || !notes.length) return []
  if (notes.some((n) => n.pitch + semis < lo || n.pitch + semis > hi)) return null
  return notes.map((n) => ({ id: n.id, pitch: n.pitch + semis }))
}

/** Move notes in time by `dTicks`, keeping them at or after the clip's start (the whole group stops together). */
export function shift(notes: Note[], dTicks: number): NotePatch[] {
  if (!notes.length || !dTicks) return []
  const first = Math.min(...notes.map((n) => n.tick))
  const d = Math.max(-first, dTicks)
  return d ? notes.map((n) => ({ id: n.id, tick: n.tick + d })) : []
}

export const clampVelocity = (v: number) => Math.min(1, Math.max(VEL_MIN, v))

/** Velocity from a pointer height in a lane `height` px tall (`y` from its top). */
export const velocityAt = (y: number, height: number) => clampVelocity(1 - y / Math.max(1, height))

/** Set every note's velocity to `v`. */
export const setVelocity = (notes: Note[], v: number): NotePatch[] =>
  notes.filter((n) => n.velocity !== clampVelocity(v)).map((n) => ({ id: n.id, velocity: clampVelocity(v) }))

/** Scale velocities about their current values: `d` is added to each, clamped. */
export const nudgeVelocity = (notes: Note[], d: number): NotePatch[] =>
  notes.map((n) => ({ id: n.id, velocity: clampVelocity(n.velocity + d) }))

/** The drum grid's alt-click: full, three quarters, half, a quarter, then full again. */
export const VELOCITY_STEPS = [1, 0.75, 0.5, 0.25]
export function nextVelocity(v: number): number {
  const i = VELOCITY_STEPS.findIndex((s) => v >= s - 0.01)
  return VELOCITY_STEPS[(i < 0 ? 0 : i + 1) % VELOCITY_STEPS.length]
}

/** The notes that overlap a marquee from tick `t0` to `t1` across pitches `p0..p1` (either order). */
export function inMarquee(notes: Note[], t0: number, t1: number, p0: number, p1: number): Note[] {
  const [ta, tb] = t0 < t1 ? [t0, t1] : [t1, t0]
  const [pa, pb] = p0 < p1 ? [p0, p1] : [p1, p0]
  return notes.filter((n) => n.pitch >= pa && n.pitch <= pb && n.tick < tb && n.tick + n.durTicks > ta)
}

/** Bars, as text, for a tick count (whole bars plain; "1.5" for a bar and a half). */
export const barsText = (ticks: number, ppq: number, beatsPerBar: number) => {
  const b = ticks / (ppq * beatsPerBar)
  return Number.isInteger(b) ? String(b) : b.toFixed(2).replace(/0$/, '')
}
