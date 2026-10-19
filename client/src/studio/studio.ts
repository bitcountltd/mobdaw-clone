// The Studio: one open project's controller and the contract between the view modules (docs/redesign.md §5).
// It holds the session, the doc, the playback engine, the local UI state and an event bus; views read its state, call
// its methods, and redraw on its events. Views never reach into each other.
import {
  DEFAULT_PPQ, DEFAULT_SAMPLE_RATE, MASTER_TRACK, addAudioClip, addLane, addMidiClip, addPad, addPoint, addTrack, clipLength, clipsMap,
  deleteLane, devicesMap, getClips, getPads, getPoints, getSampleRate, getTempo, getTracks, laneOf, lanesMap, loopersMap, metaMap,
  beginTempoChange, markersMap, migrateToV2, notesMap, padsMap, paramToPos, pointsMap, resolveTarget, samplesMap, setLaneEnabled, setLaneState, stashLaneRanges,
  sweepOrphans, tracksMap, type AwarenessState, type GridSize, type ParamTarget, type Tempo, type TrackKind,
} from '@mobdaw/shared'
import type * as Y from 'yjs'
import { onPeaks } from '../audio/peaks'
import { openPlayback, type Playback } from '../audio/playback'
import type { Session } from '../project/session'
import { importFile, PLAYBACK_MAX_BYTES } from '../samples'
import { isAudioFile } from '../fileTypes'
import { EXPORT_MIDI_EVENT, clipToSong, importSmf, isMidiFile, parseSmf, projectToSong, writeSmf } from '../content/midifile'
import { safeName, saveBlob } from '../download'
import { recoverTakes, sweepUnusedTakes, type TakeCtx } from '../takes'
import { automateMenu } from '../ui/automation'
import { numberedName } from './arrange/kinds'
import { AutoState } from './autoState'
import { PedalCtl } from './pedalCtl'
import { MidiRec } from './midiRecord'
import { RecordingCtl } from './recordingCtl'
import { snapPosition, type SnapMods } from './snap'

export type DockTab = 'clip' | 'devices'
export type UiState = {
  pps: number // zoom, pixels per second
  selection: string[] // selected clip ids
  focusTrack: string | null // the track whose devices the dock shows (last clicked header or clip); MASTER_TRACK for the master
  editing: string | null // the clip open in the dock's clip tab
  dock: { open: boolean; tab: DockTab; height: number }
  browserOpen: boolean
  view: 'arrange' | 'mix'
  grid: GridSize // snap; default 0.25 (1/16)
  follow: boolean // keep the playhead in view while playing
  armedTrack: string | null
  // Beyond the brief: sub-selections and toggles that more than one view (or the shortcuts) need.
  note: string | null // the selected note in the open MIDI clip
  pad: string | null // the selected soundscape region
  looperArm: string | null // the looper whose region is being drawn
  autoOpen: string[] // scopes (track ids, or MASTER_TRACK) with their automation lanes shown
  narrow: boolean // the studio is under 600px wide: slim track headers (set by the shell)
}
export type Meters = { master: [number, number]; tracks: Map<string, [number, number]> }
export type StudioEvents = {
  /** After any document (or awareness, or peaks) change, coalesced to one per frame. */
  doc: void
  /** After setUi, with the patch. */
  ui: Partial<UiState>
  /** Play / stop / record / arm / pedal state changed. */
  transport: void
  /** Every frame while playing (and after a seek), with the position. */
  tick: number
  meters: Meters
  /** The status bar text changed. */
  status: string
  /** Engine DSP load (twice a second). */
  cpu: { load: number; peak: number }
  /** The armed input's level changed (linear peak and whether it has hit full scale). */
  level: { level: number; clipped: boolean }
  /** Recording couldn't start (no microphone, access refused): a plain message for the record button to show. */
  recordError: string
  /** A note played by hand (computer or MIDI keyboard) started or stopped sounding on a track. */
  liveNote: { trackId: string; pitch: number; on: boolean }
}
export type StudioEvent = keyof StudioEvents

/** The layout bits of UiState that are remembered on this device. The zoom is remembered per project (PPS_KEY). */
const LAYOUT_KEY = 'mobdaw.studio.layout'
type Layout = Pick<UiState, 'grid' | 'browserOpen' | 'dock'>
function loadLayout(): Partial<Layout> {
  try {
    const { grid, browserOpen, dock } = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<Layout>
    return { ...(grid !== undefined ? { grid } : {}), ...(browserOpen !== undefined ? { browserOpen } : {}), ...(dock ? { dock } : {}) }
  } catch {
    return {}
  }
}
const PPS_KEY = (projectId: string) => `mobdaw.studio.pps.${projectId}`
function loadPps(projectId: string): number | null {
  try {
    const v = Number(localStorage.getItem(PPS_KEY(projectId)))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

// (meta: tempo, meter and loop changes redraw the views too)
const WATCHED = [metaMap, tracksMap, clipsMap, notesMap, devicesMap, loopersMap, padsMap, lanesMap, pointsMap, samplesMap, markersMap]

export class Studio {
  readonly s: Session
  readonly doc: Y.Doc
  readonly undo: Y.UndoManager
  readonly readOnly: boolean
  rate = DEFAULT_SAMPLE_RATE
  /** Created once the doc has synced (it needs meta.sampleRate). */
  pb: Playback | null = null
  ui: UiState
  destroyed = false

  readonly rec: RecordingCtl
  readonly pedal: PedalCtl
  /** Live notes (computer / MIDI keyboard) and MIDI takes. */
  readonly midi: MidiRec
  /** The automation lanes and what they drive at the playhead. */
  readonly auto = new AutoState()
  /** Collaborators' awareness states, as of the last 'doc'. */
  remote: AwarenessState[] = []
  /** Track id -> who (someone else) is recording on it. Those tracks are read-only here. */
  locks = new Map<string, string>()
  /** Device id -> param id -> a collaborator's in-progress drag value. */
  remoteDrags = new Map<string, Map<number, number>>()
  statusText = ''
  /** Whether this project's zoom was remembered on this device; when not, the arrangement zooms to fit on first open. */
  readonly zoomRemembered: boolean

  private subs = new Map<StudioEvent, Set<(arg: never) => void>>()
  private raf = 0
  private tickRaf = 0
  private lastAware = 0
  private offPeaks: () => void

  constructor(s: Session, readOnly = false) {
    this.s = s
    this.doc = s.doc
    this.undo = s.undo
    this.readOnly = readOnly
    const layout = loadLayout()
    const narrow = typeof innerWidth === 'number' && innerWidth < 900
    const pps = loadPps(s.projectId)
    this.zoomRemembered = pps != null
    this.ui = {
      pps: pps ?? 80, selection: [], focusTrack: null, editing: null, dock: { open: !narrow, tab: 'clip', height: 300 }, browserOpen: !narrow,
      view: 'arrange', grid: 0.25, follow: true, armedTrack: null, note: null, pad: null, looperArm: null, autoOpen: [],
      narrow: typeof innerWidth === 'number' && innerWidth < 600,
      ...layout,
    }
    if (narrow) this.ui.browserOpen = false
    this.rec = new RecordingCtl(this)
    this.pedal = new PedalCtl(this)
    this.midi = new MidiRec(this)

    WATCHED.forEach((m) => m(this.doc).observeDeep(this.schedule))
    s.awareness.on('change', this.schedule)
    metaMap(this.doc).observe(this.rateChanged)
    this.offPeaks = onPeaks(this.schedule)
    addEventListener(EXPORT_MIDI_EVENT, this.onExportMidi) // (the export dialog's "export MIDI")
    // After the first sync: migrate old projects (editors only: a viewer's writes never reach the server),
    // then start the engine at the project's sample rate.
    void s.synced.then(() => {
      if (this.destroyed) return
      if (!readOnly) {
        migrateToV2(this.doc)
        sweepOrphans(this.doc)
        stashLaneRanges(this.doc)
      }
      this.rate = getSampleRate(this.doc)
      this.openEngine()
      this.refresh()
      if (!readOnly) sweepUnusedTakes(this.takeCtx())
      if (!readOnly) recoverTakes(this.takeCtx()).then((n) => {
        if (n && !this.destroyed) this.status(`recovered ${n} unfinished take${n > 1 ? 's' : ''}`)
      }, (err) => console.warn('take recovery:', err))
    })
  }

  // --- events
  on<E extends StudioEvent>(ev: E, fn: (arg: StudioEvents[E]) => void): () => void {
    let set = this.subs.get(ev)
    if (!set) this.subs.set(ev, (set = new Set()))
    set.add(fn as (arg: never) => void)
    return () => void set.delete(fn as (arg: never) => void)
  }
  emit<E extends StudioEvent>(ev: E, arg?: StudioEvents[E]) {
    if (this.destroyed) return
    for (const fn of [...(this.subs.get(ev) ?? [])]) (fn as (a: StudioEvents[E] | undefined) => void)(arg)
  }

  /** Merge into the UI state, remember the layout bits on this device, and announce it. */
  setUi(patch: Partial<UiState>) {
    Object.assign(this.ui, patch)
    if ('grid' in patch || 'browserOpen' in patch || 'dock' in patch) {
      const { grid, browserOpen, dock } = this.ui
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ grid, browserOpen, dock } satisfies Layout))
      } catch { /* private mode: the layout is just not remembered */ }
    }
    if ('pps' in patch) {
      try { localStorage.setItem(PPS_KEY(this.s.projectId), String(this.ui.pps)) } catch { /* not remembered */ }
    }
    if ('selection' in patch) this.s.setLocal({ selection: this.ui.selection })
    if ('armedTrack' in patch) this.rec.sync()
    this.emit('ui', patch)
  }

  // --- time and grid
  tempo(): Tempo { return getTempo(this.doc) }
  x(smp: number) { return (smp / this.rate) * this.ui.pps }
  fromX(px: number) { return Math.max(0, Math.round((px / this.ui.pps) * this.rate)) }
  /** Timeline sample `smp` on the snap grid; held alt or ctrl (`ev`) means no snap. */
  snap(smp: number, ev?: SnapMods) {
    return snapPosition(smp, this.ui.grid, this.tempo(), this.rate, ev)
  }
  /** Where the main timeline's scroll area ends (samples): past the last clip or region, at least a minute. */
  extent() {
    const scapes = new Set(getTracks(this.doc).filter((t) => t.kind === 'soundscape').map((t) => t.id))
    // Source clips live in their own time world: they don't stretch the main timeline.
    return Math.max(60 * this.rate,
      ...getClips(this.doc).filter((c) => !scapes.has(c.trackId)).map((c) => c.start + clipLength(c, this.rate) + 30 * this.rate),
      ...getPads(this.doc).map((p) => p.start + p.length + 30 * this.rate))
  }

  // --- transport
  position() { return this.pb?.position() ?? 0 }
  get playing() { return !!this.pb?.playing }
  toggle() {
    if (!this.pb) return
    if (this.pb.playing) this.stop()
    else this.play()
  }
  play(from?: number) {
    if (!this.pb) return
    this.pb.play(from)
    this.emit('transport')
    this.startTicking()
  }
  stop() {
    const saveTake = this.rec.end()
    const saveNotes = this.midi.end()
    void this.pedal.end() // (the take must end before the engine stops)
    this.pb?.stop()
    this.s.setLocal({ playhead: null })
    this.emit('transport')
    this.emit('tick', this.position())
    saveTake?.()
    saveNotes?.()
  }
  seek(smp: number) {
    if (this.rec.take || this.pedal.active || this.midi.active) return // a take is one continuous stretch of the timeline
    this.pb?.seek(smp)
    this.auto.read(this.doc, this.position())
    this.emit('tick', this.position())
  }
  rewind() { this.seek(0) }
  /** Set by the top bar: runs before a recording starts from stopped (the count-in); resolving false cancels it. */
  beforeRecord: (() => Promise<boolean>) | null = null
  async toggleRecord() {
    if (this.midi.active) return this.stop()
    if (this.beforeRecord && !this.rec.take && !this.playing && !(await this.beforeRecord())) return
    return !this.rec.take && this.midi.wants() ? this.midi.start() : this.rec.toggle()
  }

  private startTicking() {
    if (!this.tickRaf) this.tickRaf = requestAnimationFrame(this.tick)
  }
  private tick = () => {
    this.tickRaf = 0
    const pb = this.pb
    if (this.destroyed || !pb?.playing) return
    // A take over the playback limit couldn't be played back: end it there (16-bit, so 2 bytes a sample).
    const limit = PLAYBACK_MAX_BYTES - 1024 * 1024
    if (this.rec.take && (this.position() - this.rec.take.start) * pb.recorder.info!.channels * 2 >= limit) {
      this.stop()
      return this.status('take stopped: it reached the longest take that can be played back yet')
    }
    if (this.pedal.active && (this.position() - this.pedal.since) * pb.recorder.info!.channels * 2 >= limit) {
      this.stop()
      return this.status('pedal take stopped: it reached the longest take that can be played back yet')
    }
    const p = this.position()
    if (this.auto.lanes.length) this.auto.read(this.doc, p)
    this.emit('tick', p)
    const now = performance.now()
    if (now - this.lastAware > 100) {
      this.lastAware = now
      this.s.setLocal({ playhead: p })
    }
    this.startTicking()
  }

  // --- selection
  /** Select clips. A single clip also opens in the dock's clip tab (`open`: false leaves the dock alone, e.g. on a press that may become a drag). */
  select(ids: string[], open = true) {
    const first = ids.length ? clipsMap(this.doc).get(ids[0])?.get('trackId') as string | undefined : undefined
    if (open && ids.length === 1 && first) {
      if (this.ui.editing === ids[0] && this.ui.dock.open && this.ui.dock.tab === 'clip') return this.setUi({ selection: ids, focusTrack: first })
      return this.setUi({ selection: ids, editing: ids[0], note: null, dock: { ...this.ui.dock, open: true, tab: 'clip' }, focusTrack: first })
    }
    this.setUi({ selection: ids, ...(first ? { focusTrack: first } : {}) })
  }
  /** Open a clip in the dock's clip tab (null: close it). */
  openClip(id: string | null) {
    if (id == null) return this.setUi({ editing: null, note: null })
    const trackId = clipsMap(this.doc).get(id)?.get('trackId') as string | undefined
    this.setUi({ editing: id, note: null, dock: { ...this.ui.dock, open: true, tab: 'clip' }, ...(trackId ? { focusTrack: trackId } : {}) })
  }
  focus(trackId: string | null) { this.setUi({ focusTrack: trackId }) }

  status(text: string) {
    this.statusText = text
    this.emit('status', text)
  }

  // --- edit helpers
  takeCtx(): TakeCtx {
    const { s } = this
    return { doc: this.doc, projectId: s.projectId, me: s.userId == null ? null : { id: s.userId, name: s.user.username }, rate: this.rate }
  }
  /** A name for a new track, numbered per kind ("drums 3"). */
  trackName(base: string) { return numberedName(getTracks(this.doc).map((t) => t.name), base) }
  /** A new track with the next colour (unnamed: "audio 2", "instrument 1"…). */
  addTrack(kind: TrackKind = 'audio', name?: string) {
    const tracks = getTracks(this.doc)
    return addTrack(this.doc, name ?? this.trackName(kind === 'midi' ? 'instrument' : kind), kind, undefined, undefined, tracks.length % 8)
  }
  /**
   * A tempo change in steps (the top bar's tempo drag): positions scale from where they were when it began, so a
   * drag back and forth doesn't drift, and the whole change is one undo step. Call `end()` when the drag ends.
   */
  beginTempoChange(): { set(bpm: number): void; end(): void } {
    this.undo.stopCapturing()
    const ch = beginTempoChange(this.doc)
    return { set: (bpm) => { if (!this.readOnly) ch.set(bpm) }, end: () => { ch.end(); this.undo.stopCapturing() } }
  }
  /** A MIDI clip at the project tempo, four bars long; a drum grid clip is a one-bar pattern looped across them. Opened in the dock. */
  newMidiClip(trackId: string, at: number, drums = false) {
    const { bpm, beatsPerBar } = this.tempo()
    const ppq = DEFAULT_PPQ
    const id = addMidiClip(this.doc, { trackId, start: at, bpm, ppq, lengthTicks: 4 * beatsPerBar * ppq, ...(drums ? { view: 'drums', loopTicks: beatsPerBar * ppq } : {}) })
    this.select([id])
    this.openClip(id)
    return id
  }
  /** A soundscape region: a block on the main lane during which all of the loopers are on. */
  newPad(trackId: string, at: number) {
    const id = addPad(this.doc, trackId, at, 2 * this.rate)
    this.setUi({ pad: id, selection: [] })
  }
  /** Import audio files into `trackId` (a new track each when null) from sample `at`, one after another. */
  async dropFiles(files: File[], trackId: string | null, at: number) {
    const { doc } = this
    if (trackId && this.locks.has(trackId)) return this.status(`${this.locks.get(trackId)} is recording on that track`)
    // MIDI files become clips (onto `trackId` when it is a MIDI track); audio goes on audio (or soundscape) tracks only
    for (const f of files.filter(isMidiFile)) await this.importMidi(f, trackId, at)
    files = files.filter((f) => !isMidiFile(f))
    if (trackId && tracksMap(doc).get(trackId)?.get('kind') === 'midi') trackId = null
    if (!files.length) return
    // (callers may pass everything dropped: what isn't audio is named in the status, not silently ignored)
    const skipped = files.filter((f) => !isAudioFile(f))
    files = files.filter(isAudioFile)
    const skipMsg = skipped.length === 1 ? `${skipped[0].name} isn't an audio or MIDI file.` : skipped.length ? `${skipped.length} files aren't audio or MIDI files.` : ''
    if (!files.length) return void (skipMsg && this.status(skipMsg))
    for (const f of files) {
      this.status(`uploading ${f.name}…`)
      try {
        const m = await importFile(this.s.projectId, doc, f)
        const length = Math.round(m.duration * this.rate)
        const name = f.name.replace(/\.[^.]+$/, '')
        doc.transact(() => {
          trackId ??= this.addTrack('audio', name)
          // its own name: the same audio dropped under two file names shares one stored sample, but not a label
          addAudioClip(doc, { trackId, sourceHash: m.hash, start: at, length, name })
        })
        at += length
        this.status(skipMsg)
      } catch (err) {
        this.status(`${f.name}: ${(err as Error).message}`)
      }
    }
  }
  /** Import a Standard MIDI File (content/midifile.ts) at `at`: into `trackId` when it is a MIDI track, else as new tracks. One undo step. */
  async importMidi(f: File, trackId: string | null, at: number) {
    if (this.readOnly) return
    try {
      const smf = parseSmf(await f.arrayBuffer())
      this.undo.stopCapturing()
      const r = importSmf(this.doc, smf, { at, trackId, base: f.name.replace(/\.[^.]+$/, '') })
      this.undo.stopCapturing()
      if (!r.clips.length) return this.status(`${f.name} has no notes.`)
      const into = r.into && (tracksMap(this.doc).get(r.into)?.get('name') as string)
      this.status(into ? `Imported ${f.name} into ${into}.` : `Imported ${r.tracks.length} track${r.tracks.length === 1 ? '' : 's'} from ${f.name}.`)
      this.select(r.clips.length === 1 ? r.clips : [], false)
      this.focus(r.into ?? r.tracks[0] ?? null)
    } catch (err) {
      this.status(`${f.name}: ${(err as Error).message}`)
    }
  }
  /** Download one MIDI clip, or (no id) every MIDI track of the project, as a .mid file named `name` (default: the clip's name). */
  exportMidi(clipId?: string | null, name?: string) {
    const song = clipId ? clipToSong(this.doc, clipId) : projectToSong(this.doc, name ?? 'untitled')
    if (!song) return
    if (!song.tracks.some((t) => t.notes.length)) return this.status('There are no MIDI notes to export.')
    saveBlob(new Blob([writeSmf(song) as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), `${safeName(name ?? song.name ?? 'untitled')}.mid`)
  }
  private onExportMidi = (e: Event) => this.exportMidi(null, (e as CustomEvent<{ name?: string }>).detail?.name)

  // --- automation
  /** Left / right click on a param's name offers Automate (or, once it has a lane, show / disable / delete it). */
  autoMenu(label: HTMLElement, t: ParamTarget) {
    const { doc } = this
    const lane = () => laneOf(doc, t)
    automateMenu(label, {
      state: () => { const l = lane(); return !l ? 'none' : l.enabled ? 'on' : 'off' },
      automate: () => this.automate(t),
      lfo: () => this.automate(t, true),
      show: () => this.revealAutomation(t.scope),
      toggle: () => { const l = lane(); if (l) setLaneEnabled(doc, l.id, !l.enabled) },
      remove: () => { const l = lane(); if (l) deleteLane(doc, l.id) },
    }, this.readOnly)
  }
  /** Automate a param: a lane that starts flat at its current value, so nothing changes until a point is moved (or, with `lfo`, one in LFO mode). */
  automate(t: ParamTarget, lfo = false) {
    const { doc } = this
    const r = resolveTarget(doc, t)
    if (!r) return
    doc.transact(() => {
      const id = addLane(doc, t, r.def)
      if (!getPoints(doc).some((p) => p.laneId === id)) addPoint(doc, id, 0, paramToPos(r.def, r.value), r.def.options ? 'hold' : 'linear')
      if (lfo) setLaneState(doc, id, 'lfo')
    })
    this.revealAutomation(t.scope)
  }
  revealAutomation(scope: string) {
    if (!this.ui.autoOpen.includes(scope)) this.setUi({ autoOpen: [...this.ui.autoOpen, scope] })
  }

  // --- document sync
  private schedule = () => {
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.refresh()))
  }
  /** Re-read what every view shares from the doc and awareness, tidy the UI state, and announce 'doc'. */
  private refresh() {
    if (this.destroyed) return
    const { doc, ui } = this
    // remote live-param drags -> overrides on our engine, and the values shown on controls
    this.remote = this.s.remoteStates()
    this.remoteDrags = new Map()
    for (const r of this.remote) {
      for (const d of [r.dragging ?? []].flat()) this.remoteDrags.set(d.deviceId, (this.remoteDrags.get(d.deviceId) ?? new Map()).set(d.paramId, d.value))
    }
    this.pb?.setOverrides(this.remote.flatMap((r) => [r.dragging ?? []].flat()))
    this.locks = new Map(this.remote.flatMap((r) => (r.recording ? [[r.recording.trackId, r.user.username] as [string, string]] : [])))
    // ids that no longer exist
    const clips = clipsMap(doc), tracks = tracksMap(doc)
    if (ui.selection.some((id) => !clips.has(id))) ui.selection = ui.selection.filter((id) => clips.has(id))
    if (ui.editing && !clips.has(ui.editing)) ui.editing = null
    if (ui.note && !notesMap(doc).has(ui.note)) ui.note = null
    if (ui.pad && !padsMap(doc).has(ui.pad)) ui.pad = null
    if (ui.focusTrack && ui.focusTrack !== MASTER_TRACK && !tracks.has(ui.focusTrack)) ui.focusTrack = null
    if (ui.armedTrack && !tracks.has(ui.armedTrack)) { // the armed track was deleted (setUi: the record button hears of it)
      if (!this.rec.take) this.pb?.recorder.disarm()
      this.setUi({ armedTrack: null })
      this.emit('transport')
    }
    this.rec.sync()
    this.auto.load(doc, this.position())
    this.emit('doc')
  }

  private openEngine() {
    try {
      const pb = (this.pb = openPlayback(this.doc, this.s.projectId, this.rate, this.s.userId))
      pb.recorder.onlevel = () => this.emit('level', { level: pb.recorder.level, clipped: pb.recorder.clipped })
      pb.oncpu = (m) => this.emit('cpu', m)
      // Per-track and master peak meters, once the engine reports them (docs/redesign.md §5, "Engine additions").
      const metered = pb as Playback & { onmeters?: ((m: Meters) => void) | null }
      if ('onmeters' in metered) metered.onmeters = (m) => this.emit('meters', m)
    } catch (err) {
      this.pb = null
      this.status(`sample rate: ${(err as Error).message}`)
    }
  }

  /**
   * The project's sample rate changed (here or on another machine; only possible while there are no tracks): the
   * engine and the microphone run at the project's rate, so playback is opened again.
   */
  private rateChanged = () => {
    const next = getSampleRate(this.doc)
    if (!this.pb || next === this.rate) return
    void this.pedal.set(false)
    this.pb.destroy()
    this.rate = next
    this.ui.armedTrack = null
    this.openEngine()
    this.emit('transport')
    this.schedule()
  }

  destroy() {
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    cancelAnimationFrame(this.tickRaf)
    this.pedal.destroy()
    this.rec.abandon()
    this.midi.abandon()
    WATCHED.forEach((m) => m(this.doc).unobserveDeep(this.schedule))
    this.s.awareness.off('change', this.schedule)
    metaMap(this.doc).unobserve(this.rateChanged)
    this.offPeaks()
    removeEventListener(EXPORT_MIDI_EVENT, this.onExportMidi)
    this.pb?.destroy()
    this.subs.clear()
  }
}
