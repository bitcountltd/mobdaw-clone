// The computer keyboard as an instrument, and notes from MIDI keyboards. ⇧K turns the computer keyboard on or off; while
// it is on, the middle letter row plays white keys and the row above the black keys (by physical key, so it is the
// same on any layout), Z / X shift the octave and C / V the velocity. Those keys then do nothing else.
// Both play the target MIDI track (see MidiRec.target) and are recorded during a MIDI take.
import { actionFor, getBindings, getMidiInput, midiGranted, midiOpen, midiSupported, onMidiDevices, onNote, openMidi } from '../midi'
import { noteName } from '../ui/noteName'
import { registerKeys } from './keys'
import type { Studio } from './studio'

/** Physical key -> semitones above the keyboard's lowest C. */
export const QWERTY_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
}
export const OCTAVE_MIN = -3, OCTAVE_MAX = 4
export const VELOCITIES = [20, 40, 60, 80, 100, 127]
/** The pitch a key plays: octave 0 puts A on middle C (60). Null for other keys or past the MIDI range. */
export function qwertyPitch(code: string, octave: number): number | null {
  const k = QWERTY_KEYS[code]
  if (k == null) return null
  const p = 60 + 12 * octave + k
  return p >= 0 && p <= 127 ? p : null
}
/** The next velocity step up (dir 1) or down (-1). */
export function stepVelocity(v: number, dir: 1 | -1): number {
  if (dir > 0) return VELOCITIES.find((x) => x > v) ?? VELOCITIES[VELOCITIES.length - 1]
  return [...VELOCITIES].reverse().find((x) => x < v) ?? VELOCITIES[0]
}

const PREFS = 'mobdaw.qwerty'

export class Qwerty {
  on = false
  octave = 0
  velocity = 100
  /** Key code -> the pitch it is sounding (so an octave change mid-hold still releases the right note). */
  private down = new Map<string, number>()
  private subs = new Set<() => void>()

  constructor(private st: Studio) {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { octave?: number; velocity?: number }
      if (typeof p.octave === 'number') this.octave = Math.min(OCTAVE_MAX, Math.max(OCTAVE_MIN, p.octave))
      if (typeof p.velocity === 'number') this.velocity = Math.min(127, Math.max(1, p.velocity))
    } catch { /* defaults */ }
  }

  onChange(f: () => void) {
    this.subs.add(f)
    return () => void this.subs.delete(f)
  }
  private changed() {
    try { localStorage.setItem(PREFS, JSON.stringify({ octave: this.octave, velocity: this.velocity })) } catch { /* not remembered */ }
    this.subs.forEach((f) => f())
  }
  /** The range the keys play now, e.g. "c4–f5". */
  range() { return `${noteName(60 + 12 * this.octave)}–${noteName(60 + 12 * this.octave + 17)}` }

  set(on: boolean) {
    if (on === this.on) return
    this.on = on
    if (!on) this.releaseAll()
    this.st.status(on ? `computer keyboard on: A – ' play ${this.range()} · Z X octave · C V velocity · ⇧K off` : 'computer keyboard off')
    this.changed()
  }
  toggle() { this.set(!this.on) }

  press(code: string, perfTime: number) {
    const p = qwertyPitch(code, this.octave)
    if (p == null || this.down.has(code)) return
    if (!this.st.midi.note(p, this.velocity / 127, true, perfTime)) return this.st.status('select a MIDI track to play it from the keyboard')
    this.down.set(code, p)
  }
  release(code: string, perfTime: number) {
    const p = this.down.get(code)
    if (p == null) return
    this.down.delete(code)
    this.st.midi.note(p, 0, false, perfTime)
  }
  releaseAll() {
    for (const code of [...this.down.keys()]) this.release(code, performance.now())
  }
  shiftOctave(d: number) {
    this.octave = Math.min(OCTAVE_MAX, Math.max(OCTAVE_MIN, this.octave + d))
    this.st.status(`keyboard plays ${this.range()}`)
    this.changed()
  }
  shiftVelocity(dir: 1 | -1) {
    this.velocity = stepVelocity(this.velocity, dir)
    this.st.status(`keyboard velocity ${this.velocity}`)
    this.changed()
  }
}

const instances = new WeakMap<Studio, Qwerty>()
/** The studio's computer keyboard (made by mountQwerty). */
export const qwertyOf = (st: Studio) => instances.get(st) ?? null

/** Computer keyboard shortcuts, key-up handling and MIDI keyboard input for one studio. */
export function mountQwerty(st: Studio) {
  const q = new Qwerty(st)
  instances.set(st, q)
  if (import.meta.env.DEV) (globalThis as { __mobdawStudio?: Studio }).__mobdawStudio = st // (for test scripts)
  const playing = () => q.on
  const off = registerKeys(st, [
    { key: 'k', mods: { shift: true }, run: () => q.toggle(), label: 'computer keyboard on / off', group: 'Keyboard instrument', priority: 10, readOnly: true },
    { code: Object.keys(QWERTY_KEYS), when: playing, run: (e) => q.press(e.code, e.timeStamp || performance.now()), label: 'play: white keys on the A row, black above', group: 'Keyboard instrument', display: "A – '", priority: 10, readOnly: true },
    { code: ['KeyZ', 'KeyX'], when: playing, run: (e) => q.shiftOctave(e.code === 'KeyX' ? 1 : -1), label: 'octave down / up', group: 'Keyboard instrument', display: 'Z / X', priority: 10, readOnly: true },
    { code: ['KeyC', 'KeyV'], when: playing, run: (e) => q.shiftVelocity(e.code === 'KeyV' ? 1 : -1), label: 'velocity down / up', group: 'Keyboard instrument', display: 'C / V', priority: 10, readOnly: true },
  ])
  const up = (e: KeyboardEvent) => q.release(e.code, e.timeStamp || performance.now())
  const blur = () => q.releaseAll()
  addEventListener('keyup', up)
  addEventListener('blur', blur)

  // MIDI keyboards: notes from any input play the target track. In pedal mode, the pedal input's bound switches are
  // the pedal's, not notes.
  const offNote = onNote((input, n, at) => {
    if (st.pedal.on && input === getMidiInput() && actionFor(getBindings(), { kind: 'note', channel: n.channel, number: n.pitch })) return
    st.midi.note(n.pitch, n.velocity / 127, n.on, at)
  })
  // Open MIDI without a prompt when it was allowed before (or an input is chosen for the pedal); otherwise `connectMidi`.
  void midiGranted().then((ok) => { if ((ok || getMidiInput()) && !st.destroyed) void openMidi().catch(() => {}) })
  const offDevices = onMidiDevices(() => st.emit('transport'))

  return {
    qwerty: q,
    destroy() {
      q.releaseAll()
      off()
      offNote()
      offDevices()
      removeEventListener('keyup', up)
      removeEventListener('blur', blur)
      instances.delete(st)
    },
  }
}

/** Ask for MIDI access (a browser prompt) so MIDI keyboards play the selected track. */
export async function connectMidi(st: Studio) {
  if (!midiSupported()) return st.status('this browser has no Web MIDI (try Chrome or Firefox)')
  try {
    await openMidi()
    st.status('MIDI keyboards now play the selected MIDI track')
    st.emit('transport')
  } catch (err) {
    st.status((err as Error).message)
  }
}
export { midiOpen }
