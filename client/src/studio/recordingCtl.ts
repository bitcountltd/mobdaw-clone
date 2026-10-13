// Recording (docs/engine.md §9): arming a track, the take in progress, saving it, monitoring and the input offset.
// The Studio owns one; views read `take`, `monitoring` and `studio.ui.armedTrack`, and hear about changes through 'transport'.
import { tracksMap } from '@mobdaw/shared'
import { getInputOffset, setInputOffset, type Captured } from '../audio/recording'
import { finishTake, takeJournal } from '../takes'
import { popover } from '../ui/popover'
import type { Studio } from './studio'

export type Take = { trackId: string; trackName: string; start: number; journal: ReturnType<typeof takeJournal> }

export const NO_MIC = 'No microphone found. Plug one in, or choose one in project settings.'
/** What to tell someone whose microphone couldn't be opened (never the raw DOMException). */
export function micErrorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? ''
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '').toLowerCase()
  if (name === 'NotAllowedError' || name === 'SecurityError' || /denied|not allowed|permission/.test(msg))
    return 'Microphone access is blocked. Allow it for this site in the browser, then press record again.'
  if (/cannot record|getusermedia/.test(msg)) return 'This browser cannot record audio. Try a recent Chrome, Edge, Firefox or Safari.'
  if (/engine/.test(msg)) return 'The audio engine did not start. Reload the page and try again.'
  if (name === 'NotReadableError' || /could not start|in use|not readable/.test(msg))
    return 'The microphone is busy in another app. Close it there, or choose another one in project settings.'
  return NO_MIC
}

export class RecordingCtl {
  /** The take being recorded. */
  take: Take | null = null
  /** Hear the armed track's input through its effects (local UI state). */
  monitoring = false
  private monitored: string | null = null // the track the engine is currently monitoring
  private preparing = false // asking for the microphone: ignore further presses

  constructor(private st: Studio) {}

  /** R on a track: arm this audio track (the first time, ask for the microphone) or disarm it. */
  async arm(id: string) {
    const { pb } = this.st
    if (!pb || this.take) return
    if (tracksMap(this.st.doc).get(id)?.get('kind') === 'midi') return this.st.midi.arm(id) // (no microphone for a MIDI track)
    if (this.st.ui.armedTrack === id) {
      pb.recorder.disarm()
      this.st.setUi({ armedTrack: null })
      return this.st.emit('transport')
    }
    try {
      await pb.recorder.arm()
    } catch (err) {
      return this.failed(err)
    }
    this.st.status('')
    this.st.setUi({ armedTrack: id })
    this.st.emit('transport')
  }

  /** The microphone couldn't be opened: say so plainly (the record button shows it), and in the status bar. */
  failed(err: unknown) {
    const text = micErrorText(err)
    this.st.status(text)
    this.st.emit('recordError', text)
  }

  setMonitoring(on: boolean) {
    this.monitoring = on
    this.sync()
    this.st.emit('transport')
  }

  /** Keep the engine's monitored track in step with the armed track (disarming ends monitoring). */
  sync() {
    const { pb, ui } = this.st
    const want = this.monitoring && ui.armedTrack && pb?.recorder.armed ? ui.armedTrack : null
    if (want !== this.monitored) pb?.monitor((this.monitored = want))
  }

  /**
   * ●: play and capture from the playhead, onto the armed audio track, else the focused audio track, else a new one
   * (an armed MIDI track doesn't take audio: Studio.toggleRecord sends those to MidiRec); again to stop.
   */
  async toggle() {
    const st = this.st
    const { doc, s } = st
    const pb = st.pb
    if (!pb || st.readOnly || this.preparing) return
    if (st.pedal.active) return st.status('record: the loop pedal is recording')
    if (this.take) return st.stop()
    const audio = (id: string | null) => (id && tracksMap(doc).get(id)?.get('kind') === 'audio' ? id : null)
    let armed = audio(st.ui.armedTrack)
    if (!armed || !pb.recorder.armed) {
      this.preparing = true
      try {
        await pb.recorder.arm()
      } catch (err) {
        return this.failed(err)
      } finally {
        this.preparing = false
      }
      if (st.destroyed || this.take) return
      armed = audio(st.ui.armedTrack) ?? audio(st.ui.focusTrack)
      if (!armed) armed = st.addTrack()
      st.setUi({ armedTrack: armed })
    }
    const trackId = armed
    const from = Math.round(st.position()) // (while playing, capture begins at the engine's next block: the recorder reports where)
    const info = { trackId, trackName: String(tracksMap(doc).get(trackId)!.get('name')) }
    const journal = takeJournal(s.projectId, info, st.rate, pb.recorder.info!.channels)
    try {
      pb.recorder.start((pcm, seq) => journal.chunk(pcm, seq), (pos) => journal.header(pos, pb.recorder.latency()))
    } catch (err) {
      journal.release()
      return st.status(`record: ${(err as Error).message}`)
    }
    this.take = { ...info, start: from, journal }
    st.status('')
    s.setLocal({ recording: { trackId, start: from } })
    if (!pb.playing) st.play(from)
    else st.emit('transport')
  }

  /** The transport is stopping: end the take (before the engine stops) and return what saves it afterwards. */
  end(): (() => void) | null {
    const t = this.take
    if (!t) return null
    this.take = null
    const captured = this.st.pb?.recorder.stop() // (asks the worklet to end the take before the engine stops)
    return () => {
      this.st.s.setLocal({ recording: null })
      if (captured) void this.save(t, captured)
    }
  }

  private async save(t: Take, captured: Promise<Captured | null>) {
    const { undo } = this.st
    const cap = await captured
    if (!cap) return t.journal.discard(), t.journal.release()
    this.st.status('saving take…')
    undo.stopCapturing()
    try {
      await finishTake(this.st.takeCtx(), { ...cap, trackId: t.trackId, trackName: t.trackName })
      this.st.status('')
      await t.journal.settled()
      t.journal.discard() // (on failure the backup stays, and is recovered next time)
    } catch (err) {
      this.st.status(`take: ${(err as Error).message}`)
    }
    t.journal.release()
    undo.stopCapturing()
  }

  /** The microphone choice changed: if one is open, reconnect it to the chosen device (unless a take is running). */
  async reopenInput() {
    const pb = this.st.pb
    if (!pb?.recorder.armed) return
    if (this.take) return this.st.status('the new microphone is used from the next take')
    pb.recorder.disarm()
    try {
      await pb.recorder.arm()
      this.st.status('')
    } catch (err) {
      this.st.setUi({ armedTrack: null })
      this.failed(err)
    }
    this.st.emit('transport')
  }

  /** Right-click on ●: the manual input delay for the microphone in use (added to the automatic compensation). */
  offsetMenu(e: MouseEvent) {
    const info = this.st.pb?.recorder.info
    if (!info) return this.st.status('arm a track to set the input offset of its microphone')
    popover(e.currentTarget as HTMLElement, [[`input offset: ${getInputOffset(info.deviceId)} ms (change…)`, () => {
      const v = prompt(`extra input delay in ms for "${info.label || 'this microphone'}".\npositive if takes land late, negative if early.`, String(getInputOffset(info.deviceId)))
      if (v != null && Number.isFinite(Number(v))) setInputOffset(info.deviceId, Number(v))
    }]])
  }

  /** The take was abandoned (the page is closing): its backup is recovered on the next open. */
  abandon() {
    if (!this.take) return
    this.st.s.setLocal({ recording: null })
    this.take.journal.release()
    this.take = null
  }
}
