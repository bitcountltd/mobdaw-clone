// Web MIDI: the loop pedal (pick an input, learn what its switches send, report each press once; what a press means is
// in audio/pedal.ts) and notes from any keyboard (`onNote`, played live by the studio). Thin on purpose.
// Chromium and Firefox have Web MIDI; Safari does not.
import { ACTIONS, type Action } from './audio/pedal'

/** What one foot switch sends when pressed: a note-on (velocity > 0) or a controller change (value > 0). */
export type Trigger = { kind: 'note' | 'cc'; channel: number; number: number }

/** Messages from one switch closer together than this are one press (contact bounce, or a pedal that sends a pair). */
export const DEBOUNCE_MS = 50

/** A "key down" in a raw MIDI message, or null: note-off, note-on with velocity 0, a controller at 0, and everything else are not presses. */
export function parseTrigger(data: ArrayLike<number>): Trigger | null {
  const [status = 0, number = 0, value = 0] = Array.from(data)
  const type = status & 0xf0, channel = status & 0x0f
  if (type === 0x90 && value > 0) return { kind: 'note', channel, number }
  if (type === 0xb0 && value > 0) return { kind: 'cc', channel, number }
  return null
}

/** A key on a keyboard: note-on (velocity 1..127) or note-off (a note-on with velocity 0 is one too). Null for anything else. */
export type NoteMsg = { on: boolean; channel: number; pitch: number; velocity: number }
export function parseNote(data: ArrayLike<number>): NoteMsg | null {
  const [status = 0, pitch = 0, velocity = 0] = Array.from(data)
  const type = status & 0xf0, channel = status & 0x0f
  if (type === 0x90 && velocity > 0) return { on: true, channel, pitch, velocity }
  if (type === 0x80 || type === 0x90) return { on: false, channel, pitch, velocity: 0 }
  return null
}

export const triggerKey = (t: Trigger) => `${t.kind}:${t.channel}:${t.number}`
export const sameTrigger = (a: Trigger, b: Trigger) => triggerKey(a) === triggerKey(b)

const NOTES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
export const describeTrigger = (t: Trigger) =>
  `${t.kind === 'note' ? `note ${NOTES[t.number % 12]}${Math.floor(t.number / 12) - 1}` : `cc ${t.number}`} · ch ${t.channel + 1}`

/** Drops a trigger seen again within `DEBOUNCE_MS` (event times in ms, any clock as long as it is the same one). */
export function debouncer(window = DEBOUNCE_MS) {
  const last = new Map<string, number>()
  return (t: Trigger, at: number) => {
    const k = triggerKey(t), prev = last.get(k)
    last.set(k, at)
    return prev == null || at - prev >= window || at < prev // (an earlier stamp: the clock restarted)
  }
}

// --- settings kept in this browser
const inputKey = 'mobdaw.midiInput'
const bindKey = 'mobdaw.pedalBindings'
/** The MIDI input chosen in the project settings (an input id); empty = none. */
export const getMidiInput = () => localStorage.getItem(inputKey) ?? ''
export const setMidiInput = (id: string) => (id ? localStorage.setItem(inputKey, id) : localStorage.removeItem(inputKey))

export type Bindings = Partial<Record<Action, Trigger>>
export function getBindings(): Bindings {
  try {
    const raw = JSON.parse(localStorage.getItem(bindKey) ?? '{}') as Bindings
    return Object.fromEntries(ACTIONS.flatMap((a) => (raw[a] && typeof raw[a]!.number === 'number' ? [[a, raw[a]]] : [])))
  } catch {
    return {}
  }
}
/** Bind `t` to `action` (or clear it); a switch means one action, so another action that had it loses it. */
export function setBinding(action: Action, t: Trigger | null) {
  const b = getBindings()
  for (const a of ACTIONS) if (t && b[a] && sameTrigger(b[a]!, t)) delete b[a]
  if (t) b[action] = t
  else delete b[action]
  localStorage.setItem(bindKey, JSON.stringify(b))
}
export const actionFor = (b: Bindings, t: Trigger): Action | null => ACTIONS.find((a) => b[a] && sameTrigger(b[a]!, t)) ?? null

// --- access
export const midiSupported = () => typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
const debug = () => !!localStorage.getItem('mobdaw.midiDebug')

export type MidiInputInfo = { id: string; name: string }
type Hit = { input: string; trigger: Trigger; at: number }

let access: Promise<MIDIAccess> | null = null
const subs = new Set<(h: Hit) => void>()
const noteSubs = new Set<(input: string, n: NoteMsg, at: number) => void>()
const changed = new Set<() => void>()
let learner: ((h: Hit) => void) | null = null
const accept = debouncer()

function attach(a: MIDIAccess) {
  for (const input of a.inputs.values()) {
    input.onmidimessage = (e) => {
      const data = e.data ?? new Uint8Array()
      const trigger = parseTrigger(data)
      // (a stamp of 0 or from another clock would defeat the debounce: fall back to now)
      const at = e.timeStamp > 0 ? e.timeStamp : performance.now()
      const note = noteSubs.size && !learner ? parseNote(data) : null
      if (note) noteSubs.forEach((f) => f(input.id, note, at)) // (not debounced: a fast trill is music)
      if (debug()) console.log(`midi ${input.name} [${[...data].map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`, trigger ? describeTrigger(trigger) : 'ignored', `t=${at.toFixed(1)}`)
      if (!trigger || !accept(trigger, at)) return
      const hit = { input: input.id, trigger, at }
      if (learner) learner(hit)
      else subs.forEach((f) => f(hit))
    }
  }
}

/** Ask for MIDI access (the browser may prompt once). Rejects with a readable message. */
export function openMidi(): Promise<MIDIAccess> {
  if (!midiSupported()) return Promise.reject(new Error('this browser has no Web MIDI'))
  return (access ??= navigator.requestMIDIAccess().then((a) => {
    attach(a)
    a.onstatechange = () => (attach(a), changed.forEach((f) => f()))
    return a
  }, (e: DOMException) => {
    access = null
    throw new Error(e.name === 'SecurityError' || e.name === 'NotAllowedError' ? 'MIDI access was denied' : `MIDI: ${e.message}`)
  }))
}

/** Whether MIDI access was already granted (so opening it shows no prompt). */
export async function midiGranted(): Promise<boolean> {
  if (!midiSupported()) return false
  if (access) return true
  try {
    return (await navigator.permissions.query({ name: 'midi' as PermissionName })).state === 'granted'
  } catch {
    return false
  }
}
/** Whether MIDI access is open in this page. */
export const midiOpen = () => !!access

/** Call `f(inputId, note, timeStamp)` for each note-on and note-off from any input (performance.now clock, ms). Returns the unsubscribe function. */
export function onNote(f: (input: string, n: NoteMsg, at: number) => void) {
  noteSubs.add(f)
  return () => void noteSubs.delete(f)
}

export async function listMidiInputs(): Promise<MidiInputInfo[]> {
  const a = await openMidi()
  return [...a.inputs.values()].map((i) => ({ id: i.id, name: i.name || i.id }))
}

/** Called when inputs are plugged or unplugged. Returns the function that stops it. */
export function onMidiDevices(f: () => void) {
  changed.add(f)
  return () => void changed.delete(f)
}

/** Call `f(trigger, timeStamp)` for each press on input `id` (timeStamp: performance.now clock, ms). Returns the unsubscribe function. */
export function onPress(id: string, f: (t: Trigger, at: number) => void) {
  const sub = (h: Hit) => h.input === id && f(h.trigger, h.at)
  subs.add(sub)
  return () => void subs.delete(sub)
}

/**
 * Resolve with the next press on input `id`; while this waits, presses do not reach `onPress` subscribers (so learning a
 * switch does not also fire it). `cancel` ends it early, rejecting.
 */
export function learn(id: string): { done: Promise<Trigger>; cancel(): void } {
  let cancel = () => {}
  const done = new Promise<Trigger>((resolve, reject) => {
    const mine = (h: Hit) => {
      if (h.input !== id) return
      learner = null
      resolve(h.trigger)
    }
    learner = mine
    cancel = () => {
      if (learner === mine) learner = null
      reject(new Error('cancelled'))
    }
  })
  return { done, cancel }
}
