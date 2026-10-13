// Loop pedal mode (docs/engine.md §9.2, audio/pedal.ts, ui/pedalSession.ts): MIDI presses (or the keys 1-4) drive loops,
// placed on the timeline where they were heard. The Studio owns one; changes are announced with 'transport'.
import type { Action } from '../audio/pedal'
import { actionFor, getBindings, getMidiInput, midiSupported, onPress, openMidi } from '../midi'
import { pedalSession, type PedalView } from '../ui/pedalSession'
import type { Studio } from './studio'

export class PedalCtl {
  /** Pedal mode is on (local UI state). */
  on = false
  private session: ReturnType<typeof pedalSession> | null = null
  private off = () => {} // stops listening to the MIDI input

  constructor(private st: Studio) {}

  /** A layer is being recorded. */
  get active() { return !!this.session?.active }
  /** Where the session's continuous take began (samples). */
  get since() { return this.session?.since ?? 0 }
  view(): PedalView | null { return this.session?.view() ?? null }

  /** Why the pedal can't be switched on, or '' when it can. */
  why(): string {
    return this.st.readOnly ? 'you can only view this project'
      : !midiSupported() ? 'loop pedal: this browser has no Web MIDI (try Chrome or Firefox)'
      : !getMidiInput() ? 'loop pedal: choose a MIDI input in the project settings first' : ''
  }

  /** Pedal mode on (the microphone and the MIDI input are opened) or off (the session, if any, ends). */
  async set(on: boolean) {
    const st = this.st
    if (on === this.on) return
    if (!on) {
      this.on = false
      this.off()
      const ended = this.session?.end()
      this.session = null
      const idle = () => !this.on && !st.ui.armedTrack && !st.rec.take
      void ended?.then(() => idle() && st.pb?.recorder.disarm())
      if (!ended && idle()) st.pb?.recorder.disarm()
      return this.changed()
    }
    const pb = st.pb
    if (!pb || st.readOnly || st.rec.take || !midiSupported() || !getMidiInput()) return
    try {
      await openMidi()
      await pb.recorder.arm()
    } catch (err) {
      return st.status(`pedal: ${(err as Error).message}`)
    }
    if (st.destroyed || this.on || !st.pb) return
    this.on = true
    st.status('')
    this.session = pedalSession({
      doc: st.doc, undo: st.undo, pb, rate: st.rate, projectId: st.s.projectId, takeCtx: () => st.takeCtx(),
      play: () => st.play(), changed: () => this.changed(), fail: (m) => st.status(m),
    })
    this.listen()
    this.changed()
  }

  /** (Re)listen to the chosen MIDI input. */
  listen() {
    this.off()
    this.off = onPress(getMidiInput(), (t, at) => {
      const a = actionFor(getBindings(), t)
      if (a) this.press(a, at)
    })
  }

  /** The project settings changed the MIDI input or a binding. */
  settingsChanged() {
    if (this.on && !getMidiInput()) void this.set(false)
    else if (this.on) this.listen() // the input may have changed
    this.changed()
  }

  press(a: Action, at: number) {
    if (!this.session || this.st.destroyed) return
    if (this.st.rec.take) return this.st.status('pedal: stop recording first')
    this.session.press(a, at)
  }

  /** The transport stops: the session's take ends (before the engine stops). */
  end() { return this.session?.end() }

  private changed() { this.st.emit('transport') }

  destroy() {
    this.off()
    this.session?.abandon() // (its backup is recovered on the next open)
  }
}
