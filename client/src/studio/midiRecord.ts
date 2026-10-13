// Live notes and MIDI recording. Everything that plays notes by hand (the computer keyboard, a MIDI keyboard) goes
// through `MidiRec.note`: it sounds on the target MIDI track (the armed one, else the focused one) and, while a MIDI
// take runs, is written down.
//
// A take starts at the playhead and its clip at the start of that bar. Notes are placed where they were heard
// (`pb.heard`, the performer's clock), not quantized. While the take runs, a growing clip shows on the lane; it is
// written outside the undo history and replaced on stop by the finished clip in one undoable step (length rounded up
// to whole bars). An empty take leaves nothing behind.
import { DEFAULT_PPQ, addMidiClip, addNote, clipsMap, deleteClip, getTempo, tracksMap, updateClip, MASTER_TRACK } from '@mobdaw/shared'
import type { Studio } from './studio'

/** A note-on or -off at timeline sample `at`. Velocity 0..1. */
export type TimedNote = { pitch: number; velocity: number; on: boolean; at: number }
export type TakeOpts = { from: number; end: number; rate: number; bpm: number; beatsPerBar: number; ppq: number }
export type BuiltNote = { tick: number; durTicks: number; pitch: number; velocity: number }
export type BuiltTake = { start: number; lengthTicks: number; notes: BuiltNote[] }

/** The bar (in samples) that `pos` falls in. */
export function barStart(pos: number, o: Pick<TakeOpts, 'rate' | 'bpm' | 'beatsPerBar'>) {
  const bar = (o.beatsPerBar * 60 / o.bpm) * o.rate
  return Math.round(Math.floor(pos / bar + 1e-9) * bar)
}

/**
 * Turn timed note events into a clip: it starts at the bar of `from`, notes pair up per pitch in arrival order (a note
 * still held at `end` ends there), and the length covers `end` and every note, rounded up to whole bars. Null when no
 * note was played.
 */
export function buildTake(events: TimedNote[], o: TakeOpts): BuiltTake | null {
  const start = barStart(o.from, o)
  const held = new Map<number, TimedNote[]>()
  const notes: BuiltNote[] = []
  for (const e of events) {
    const q = held.get(e.pitch) ?? []
    if (e.on) held.set(e.pitch, [...q, e])
    else if (q.length) {
      notes.push(noteFor(q[0], e.at, start, o))
      held.set(e.pitch, q.slice(1))
    }
  }
  for (const q of held.values()) for (const on of q) notes.push(noteFor(on, Math.max(o.end, on.at), start, o))
  if (!notes.length) return null
  notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
  return { start, lengthTicks: lengthFor(Math.max(ticksAt(o.end, start, o), ...notes.map((n) => n.tick + n.durTicks)), o), notes }
}

/** Timeline sample `smp` in ticks from the clip start `start` (not before it). */
export const ticksAt = (smp: number, start: number, o: Pick<TakeOpts, 'rate' | 'bpm' | 'ppq'>) =>
  Math.max(0, Math.round((smp - start) * (o.bpm / 60) * o.ppq / o.rate))
/** Whole bars (in ticks) that cover `ticks`; at least one. */
export const lengthFor = (ticks: number, o: Pick<TakeOpts, 'beatsPerBar' | 'ppq'>) =>
  Math.max(1, Math.ceil(ticks / (o.beatsPerBar * o.ppq) - 1e-9)) * o.beatsPerBar * o.ppq
/** The note a note-on makes when released at `offAt` (a very short tap still gets a 1/128). */
export function noteFor(on: TimedNote, offAt: number, start: number, o: Pick<TakeOpts, 'rate' | 'bpm' | 'ppq'>): BuiltNote {
  const t = ticksAt(on.at, start, o)
  return { tick: t, durTicks: Math.max(Math.max(1, Math.round(o.ppq / 32)), ticksAt(offAt, start, o) - t), pitch: on.pitch, velocity: Math.min(1, Math.max(0.01, on.velocity)) }
}

/** Transactions with this origin stay out of the undo history (the live view of a take). */
const LIVE = 'mobdaw:midi-live'

type MidiTake = { trackId: string; from: number; start: number; events: TimedNote[]; held: Map<number, TimedNote[]>; live: string | null; offTick: () => void }

export class MidiRec {
  take: MidiTake | null = null
  /** Sounding notes: pitch -> the track it went to (so the release reaches the same one). */
  private sounding = new Map<number, string>()

  constructor(private st: Studio) {}

  get active() { return !!this.take }

  private isMidi = (id: string | null | undefined) => !!id && id !== MASTER_TRACK && tracksMap(this.st.doc).get(id)?.get('kind') === 'midi'

  /** The MIDI track live notes go to: the armed track, else the focused one, else the open clip's. */
  target(): string | null {
    const { ui, doc } = this.st
    if (this.take) return this.take.trackId
    if (this.isMidi(ui.armedTrack)) return ui.armedTrack
    if (this.isMidi(ui.focusTrack)) return ui.focusTrack
    const t = ui.editing ? clipsMap(doc).get(ui.editing)?.get('trackId') as string | undefined : undefined
    return this.isMidi(t) ? t! : null
  }

  /** A MIDI track notes can be recorded on (not the click track). */
  private recordable = (id: string | null | undefined) => this.isMidi(id) && tracksMap(this.st.doc).get(id!)?.get('role') !== 'click'
  /**
   * The track a MIDI take goes on (D4): the focused instrument track, else the armed one unless an audio track is
   * focused (then it is an audio take). Null: the record button records audio.
   */
  recordTarget(): string | null {
    const { ui, doc } = this.st
    if (this.take) return this.take.trackId
    if (this.recordable(ui.focusTrack)) return ui.focusTrack
    if (ui.focusTrack && tracksMap(doc).get(ui.focusTrack)?.get('kind') === 'audio') return null
    return this.recordable(ui.armedTrack) ? ui.armedTrack : null
  }
  /** Whether the record button means a MIDI take. */
  wants(): boolean {
    return this.take != null || this.recordTarget() != null
  }

  /** Arm (or disarm) a MIDI track: no microphone, it just picks where notes go and are recorded. */
  arm(id: string) {
    const st = this.st
    if (this.take || st.rec.take) return
    if (st.ui.armedTrack === id) st.setUi({ armedTrack: null })
    else {
      if (st.ui.armedTrack && !this.isMidi(st.ui.armedTrack)) st.pb?.recorder.disarm()
      st.setUi({ armedTrack: id })
    }
    st.emit('transport')
  }

  /**
   * Play a note by hand on the target track (velocity 0..1); `perfTime` is when it happened (performance.now clock: an
   * event's timeStamp). Returns false when there is no MIDI track to play.
   */
  note(pitch: number, velocity: number, on: boolean, perfTime = performance.now()): boolean {
    const { pb } = this.st
    if (!pb) return false
    if (!on) {
      const t = this.sounding.get(pitch)
      if (t == null) return false
      this.sounding.delete(pitch)
      pb.noteLive(t, pitch, 0, false)
      this.st.emit('liveNote', { trackId: t, pitch, on: false })
      this.record(pitch, 0, false, perfTime)
      return true
    }
    const t = this.target()
    if (!t) return false
    const prev = this.sounding.get(pitch)
    if (prev != null) pb.noteLive(prev, pitch, 0, false), this.record(pitch, 0, false, perfTime), this.st.emit('liveNote', { trackId: prev, pitch, on: false })
    this.sounding.set(pitch, t)
    pb.noteLive(t, pitch, velocity, true)
    this.st.emit('liveNote', { trackId: t, pitch, on: true })
    this.record(pitch, velocity, true, perfTime)
    return true
  }
  /** Let go of every sounding note (focus lost, keyboard off). */
  releaseAll() {
    for (const p of [...this.sounding.keys()]) this.note(p, 0, false)
  }

  private record(pitch: number, velocity: number, on: boolean, perfTime: number) {
    const tk = this.take, pb = this.st.pb
    if (!tk || !pb || !pb.playing) return
    const at = Math.max(0, pb.heard(perfTime))
    const e = { pitch, velocity, on, at }
    tk.events.push(e)
    const q = tk.held.get(pitch) ?? []
    if (on) return void tk.held.set(pitch, [...q, e])
    if (!q.length) return
    tk.held.set(pitch, q.slice(1))
    this.showLive(noteFor(q[0], at, tk.start, this.opts(at)))
  }

  /** ● on a MIDI track: play from the playhead and record. */
  start() {
    const st = this.st
    if (!st.pb || st.readOnly || this.take || st.rec.take) return
    if (st.pedal.active) return st.status('record: the loop pedal is recording')
    const trackId = this.recordTarget()
    if (!trackId) return
    if (st.locks.has(trackId)) return st.status(`${st.locks.get(trackId)} is recording on that track`)
    if (st.ui.armedTrack !== trackId) { // the take's track is armed (a microphone armed elsewhere is let go)
      if (st.ui.armedTrack && !this.isMidi(st.ui.armedTrack)) st.pb.recorder.disarm()
      st.setUi({ armedTrack: trackId })
    }
    const from = Math.round(st.position())
    this.take = { trackId, from, start: barStart(from, this.opts(from, from)), events: [], held: new Map(), live: null, offTick: st.on('tick', () => this.grow()) }
    st.s.setLocal({ recording: { trackId, start: from } })
    st.status('recording notes: play the computer keyboard (⇧K) or a MIDI keyboard')
    // Notes already held when recording starts count from here.
    for (const [p, t] of this.sounding) {
      if (t !== trackId) continue
      const e = { pitch: p, velocity: 0.8, on: true, at: from }
      this.take.events.push(e)
      this.take.held.set(p, [e])
    }
    if (!st.pb.playing) st.play(from)
    else st.emit('transport')
  }

  private opts(end: number, from = this.take?.from ?? 0): TakeOpts {
    const { bpm, beatsPerBar } = getTempo(this.st.doc)
    return { from, end, rate: this.st.rate, bpm, beatsPerBar, ppq: DEFAULT_PPQ }
  }

  /** Add a finished note to the take's live clip (made on the first one), outside the undo history. */
  private showLive(n: BuiltNote) {
    const tk = this.take
    if (!tk) return
    const { doc } = this.st
    const o = this.opts(this.st.position())
    doc.transact(() => {
      if (tk.live && !clipsMap(doc).has(tk.live)) tk.live = null
      const len = lengthFor(Math.max(n.tick + n.durTicks, ticksAt(this.st.position(), tk.start, o)), o)
      if (!tk.live) tk.live = addMidiClip(doc, { trackId: tk.trackId, start: tk.start, bpm: o.bpm, ppq: o.ppq, lengthTicks: len })
      else if (len > Number(clipsMap(doc).get(tk.live)!.get('lengthTicks'))) updateClip(doc, tk.live, { lengthTicks: len })
      addNote(doc, { ...n, clipId: tk.live })
    }, LIVE)
  }
  /** Each frame: lengthen the live clip when the playhead crosses into the next bar. */
  private grow() {
    const tk = this.take
    if (!tk?.live) return
    const c = clipsMap(this.st.doc).get(tk.live)
    if (!c) return
    const o = this.opts(this.st.position())
    const need = lengthFor(ticksAt(this.st.position(), tk.start, o), o)
    if (need > Number(c.get('lengthTicks'))) this.st.doc.transact(() => updateClip(this.st.doc, tk.live!, { lengthTicks: need }), LIVE)
  }

  /** The transport is stopping: end the take (call before the engine stops) and return what writes it afterwards. */
  end(): (() => void) | null {
    const tk = this.take
    if (!tk) return null
    this.take = null
    tk.offTick()
    const st = this.st
    const built = buildTake(tk.events, this.opts(Math.max(tk.from, Math.round(st.position()))))
    return () => {
      const { doc, undo } = st
      st.s.setLocal({ recording: null })
      if (tk.live && clipsMap(doc).has(tk.live)) doc.transact(() => deleteClip(doc, tk.live!), LIVE)
      if (!built) return st.status('nothing recorded: no notes were played')
      if (!tracksMap(doc).has(tk.trackId)) return
      undo.stopCapturing()
      let id = ''
      doc.transact(() => {
        id = addMidiClip(doc, { trackId: tk.trackId, start: built.start, bpm: getTempo(doc).bpm, ppq: DEFAULT_PPQ, lengthTicks: built.lengthTicks })
        for (const n of built.notes) addNote(doc, { ...n, clipId: id })
      })
      undo.stopCapturing()
      st.select([id])
      st.status(`recorded ${built.notes.length} note${built.notes.length > 1 ? 's' : ''}`)
    }
  }

  /** The page is closing mid-take: drop the live clip. */
  abandon() {
    const tk = this.take
    if (!tk) return
    this.take = null
    tk.offTick()
    if (tk.live && clipsMap(this.st.doc).has(tk.live)) this.st.doc.transact(() => deleteClip(this.st.doc, tk.live!), LIVE)
  }
}
