// Recording (docs/engine.md §9): arming a track, the take in progress, saving it, monitoring and the input offset.
// The Studio owns one; views read `take`, `monitoring` and `studio.ui.armedTrack`, and hear about changes through 'transport'.
import { tracksMap } from '@mobdaw/shared'
import { getInputOffset, setInputOffset, type Captured } from '../audio/recording'
import { finishTake, takeJournal } from '../takes'
import { popover } from '../ui/popover'
import type { Studio } from './studio'

export type Take = { trackId: string; trackName: string; start: number; journal: ReturnType<typeof takeJournal> }

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
      return this.st.status(`record: ${(err as Error).message}`)
    }
    this.st.status('')
    this.st.setUi({ armedTrack: id })
    this.st.emit('transport')
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

  /** ●: play and capture from the playhead (onto a new track if none is armed); again to stop. */
  async toggle() {
    const st = this.st
    const { doc, s } = st
    const pb = st.pb
    if (!pb || st.readOnly || this.preparing) return
    if (st.pedal.active) return st.status('record: the loop pedal is recording')
    if (this.take) return st.stop()
    let armed = st.ui.armedTrack
    if (!armed || !tracksMap(doc).has(armed) || !pb.recorder.armed) {
      this.preparing = true
      try {
        await pb.recorder.arm()
      } catch (err) {
        return st.status(`record: ${(err as Error).message}`)
      } finally {
        this.preparing = false
      }
      if (st.destroyed || this.take) return
      armed = st.ui.armedTrack
      if (!armed || !tracksMap(doc).has(armed)) armed = st.addTrack()
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
      this.st.status(`record: ${(err as Error).message}`)
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
