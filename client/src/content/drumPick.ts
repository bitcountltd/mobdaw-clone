// Using the drum synth's sound library (content/drumSounds.ts) on a project: put a sound on a drum, tell which sound a
// drum's values are, step through a category, add a sound as a new drum.
import { DEVICES, DRUM_SYNTH, addDrum, paramToPos, setParam, updateDevice, type Device } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { DRUM_SOUNDS, fullParams, type DrumSound } from './drumSounds'

/** A sound's values, every param filled in and inside its range. */
export function soundParams(s: DrumSound): Record<string, number> {
  const all = fullParams(s)
  const out: Record<string, number> = {}
  for (const p of DEVICES[DRUM_SYNTH].params) {
    const v = all[String(p.id)] ?? p.def
    out[String(p.id)] = Math.min(p.max, Math.max(p.min, v))
  }
  return out
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))

/** The sound a drum synth's values are now (one with the drum's name first, when several match), or null. */
export function soundMatching(dev: Pick<Device, 'type' | 'name' | 'params'>): DrumSound | null {
  if (dev.type !== DRUM_SYNTH) return null
  const defs = DEVICES[DRUM_SYNTH].params
  const is = (s: DrumSound) => {
    const want = soundParams(s)
    return defs.every((p) => near(dev.params?.[p.id] ?? p.def, want[String(p.id)]))
  }
  const named = DRUM_SOUNDS.find((s) => s.name === dev.name && is(s))
  return named ?? DRUM_SOUNDS.find(is) ?? null
}

/** Params a kit tweaks freely (placement and colour): they count for little when finding the nearest sound. */
const MIX = new Set([17, 18, 19, 20, 21, 22])

/**
 * The library sound a drum synth's values are closest to: the same model, and on average within a few percent of each
 * knob's travel (a kit's take on a sound: tuned, panned, darker). Null when nothing is that close.
 */
export function soundNearest(dev: Pick<Device, 'type' | 'name' | 'params'>): DrumSound | null {
  if (dev.type !== DRUM_SYNTH) return null
  const defs = DEVICES[DRUM_SYNTH].params
  const val = (id: number) => dev.params?.[id] ?? defs[id].def
  let best: DrumSound | null = null
  let bestD = 0.06
  for (const s of DRUM_SOUNDS) {
    const want = soundParams(s)
    if (Math.round(val(0)) !== Math.round(want['0'])) continue
    let d = 0
    for (const p of defs) d += Math.abs(paramToPos(p, val(p.id)) - paramToPos(p, want[String(p.id)])) * (MIX.has(p.id) ? 0.2 : 1)
    d /= defs.length
    if (d < bestD || (d === bestD && s.name === dev.name)) (best = s), (bestD = d)
  }
  return best
}

/** Put a sound on a drum: all its params, and its name (one transaction; the caller makes it one undo step). */
export function applyDrumSound(doc: Y.Doc, deviceId: string, s: DrumSound) {
  doc.transact(() => {
    for (const [pid, v] of Object.entries(soundParams(s))) setParam(doc, deviceId, Number(pid), v)
    updateDevice(doc, deviceId, { name: s.name })
  })
}

/** The sound `dir` steps from `from` within its category (wrapping round); from nothing, the first (or last) sound. */
export function soundStep(from: DrumSound | null, dir: 1 | -1): DrumSound | null {
  if (!from) return (dir > 0 ? DRUM_SOUNDS[0] : DRUM_SOUNDS.at(-1)) ?? null
  const list = DRUM_SOUNDS.filter((s) => s.category === from.category)
  const i = list.findIndex((s) => s.id === from.id)
  if (i < 0) return list[0] ?? null
  return list[(i + dir + list.length) % list.length]
}

/** Add a sound as a new drum (a drum synth on the track's next free key, named after it). Returns its id. */
export function addDrumSound(doc: Y.Doc, trackId: string, s: DrumSound): string {
  return addDrum(doc, trackId, { type: DRUM_SYNTH, name: s.name, params: soundParams(s) })
}
