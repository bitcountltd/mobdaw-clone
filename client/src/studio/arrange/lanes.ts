// The arrangement's lanes: one row per track (its header from tracks.ts, then a body holding clips, soundscape regions and
// takes in progress), a soundscape's source lane and loopers, the automation sections, and the master row. This is the old
// timeline core: plain absolutely-positioned DOM, keyed reuse, redrawn from the Studio's events.
// Positions in the doc are integer samples; the zoom is the Studio's pixels per second.
import {
  DEVICES, FINNWAVE, MASTER_TRACK, addDevice, addNextLooper, clipLength, clipsMap, deleteClip, deleteLooper, deletePad, getClips, getDevices, getLoopers, getNotes, getPads, notesMap,
  getSamples, getTracks, isDrum, isForever, isLooping, padsMap, passLength, resolveTarget, splitClip, trackColor, tracksMap, updateClip, updateLooper, updatePad,
  type Clip, type Device, type Lane as AutoLane, type Looper, type Note, type Pad, type ParamTarget, type SampleMeta, type Track,
} from '@mobdaw/shared'
import { drawWave, peaksFor, storedPeaks } from '../../audio/peaks'
import { DRUM_KITS, addDrumKit } from '../../content/presets'
import type { PreviewMode } from '../../audio/bridge'
import { h } from '../../dom'
import { playable } from '../../samples'
import { discardTake, hasStaged, isMine, myTakes, uploadAll, uploadTake } from '../../takes'
import { autoRow } from '../../ui/automation'
import { clamp, dragPointer, grabAt, passBoundaries, snapTracker, trimBlock, type Grab } from '../../ui/blocks'
import { LOOP_COLORS, looperCard } from '../../ui/loopers'
import { closedBy, deleteMenu, popover, type MenuItem } from '../../ui/popover'
import { icon } from '../../theme/icons'
import { transportControls, type TransportControls } from '../../ui/transport'
import { clipboard, copyClips, cutClips, duplicateClips, moveGroup, pasteClips } from '../clipboard'
import { canDrop, applyDrop, hasPayload, readDragPayload, type DropPayload } from '../drops'
import { IS_MAC } from '../keys'
import { kindOf } from './kinds'
import type { Studio } from '../studio'
import { registerArrangeKeys } from './edit'
import { heightsFor } from './heights'
import { MIN_SEC, loopClip, passClip, setLoopOff, setLoopOn, sourceFrames, trimClip } from './clipOps'
import { drawTicks } from './ruler'
import type { mountTrackHeaders } from './tracks'

/** The track header (200) plus the gutter to its left; keep in step with --head / --gutter in arrange.css. */
export const HEADER_WIDE = 206
/** Under 600px (`.studio.narrow`): a 128px header with only the name and m / s / arm (--head: 128px). */
export const HEADER_NARROW = 134
/** The header column's width now (a live binding: it follows `ui.narrow`, see setNarrowHeader). */
export let HEADER = HEADER_WIDE
export function setNarrowHeader(narrow: boolean) { HEADER = narrow ? HEADER_NARROW : HEADER_WIDE }
const SNAP_PX = 8 // a dragged clip snaps to an edge within this many px...
const REARM_PX = 24 // ...and, once pulled free, only snaps to it again after moving this far away
const CLIP_HEAD = 14 // a clip's name strip; the waveform or notes fill the rest of its height (keep in step with arrange.css)
const CLIP_INSET = 1 // a clip's gap to the top and bottom of its lane
const SRC_H = 72 // a soundscape's source lane (its own row, with a 14 px ruler on top)
const FADE_SHAPES = ['equal power', 'linear', 's-curve'] as const
/** A fade's gain at 0..1 through it, by shape (0 equal-power, 1 linear, 2 s-curve). */
const fadeGain = (t: number, shape: number) => (shape === 1 ? t : shape === 2 ? (1 - Math.cos(Math.PI * t)) / 2 : Math.sin((t * Math.PI) / 2))

const accepts = (trackKind: string, clipKind: string) => trackKind === clipKind
export const audioFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name))

/** A scope's automation: one collapsible section holding a lane per automated param (hidden when there are none). */
type AutoSec = { el: HTMLElement; toggle: HTMLButtonElement; box: HTMLElement; rows: Map<string, ReturnType<typeof autoRow>> }
type Lane = {
  el: HTMLElement; row: HTMLElement; body: HTMLElement
  loopMore: HTMLButtonElement; loopRow: HTMLElement; loops: HTMLElement
  loopCards: Map<string, ReturnType<typeof looperCard>>; boxes: Map<string, HTMLElement>; heads: Map<string, HTMLElement>
  pads: Map<string, HTMLElement>
  auto: AutoSec
  loopTc: TransportControls // loops preview transport
  /** Soundscape tracks only: the source lane, which has its own time axis, scroll and zoom. */
  src: Src | null
}
type Src = {
  row: HTMLElement; view: HTMLElement; body: HTMLElement; ticks: HTMLElement; pps: number
  more: HTMLButtonElement // collapse toggle in the header cell
  tc: TransportControls // source preview transport
  playhead: HTMLElement // the preview's own playhead, in source time
  end: number // where the source audio ends (samples)
}
type Wave = {
  cv: HTMLCanvasElement; seams: HTMLElement; first: HTMLElement; label: HTMLElement; notches: HTMLElement
  fade: SVGSVGElement; fin: HTMLElement; fout: HTMLElement
  sig: string; pk?: Float32Array; v0: number; v1: number
}
/** Every clip: its name strip and the body under it. */
type Parts = { head: HTMLElement; name: HTMLElement; body: HTMLElement; midiKey?: string }

export type LanesFrame = {
  /** The arrangement's scroller (both axes): the lanes' horizontal scroll and the visible window for waveforms. */
  scroll: HTMLElement
}

export function mountLanes(st: Studio, frame: LanesFrame, headers: ReturnType<typeof mountTrackHeaders>) {
  const { doc, undo, readOnly, s } = st
  const { scroll } = frame
  const lanes = new Map<string, Lane>()
  const clipEls = new Map<string, HTMLElement>()
  const waves = new Map<string, Wave>()
  const recRegions = new Map<string, HTMLElement>()
  const pedalEls = new Map<string, HTMLElement>() // the pedal's layer being recorded and its live loops
  const staged = new Map<string, boolean>() // incoming take hash -> whether this device still has its audio
  const srcShown = new Set<string>() // soundscapes with the source lane expanded (collapsed by default)
  const loopShown = new Set<string>() // soundscape tracks with the loopers row expanded (collapsed by default)
  let autoShownBefore = new Set<string>()
  let destroyed = false
  let raf = 0
  // the notes grouped by clip, re-read only when a note changes (a zoom or a clip move doesn't touch them); the version
  // keys each MIDI clip's preview so an unchanged one skips even building its signature
  let notesVer = 0, notesReadVer = -1
  let notesBy = new Map<string, Note[]>()
  const onNotes = () => { notesVer++ }
  notesMap(doc).observeDeep(onNotes)
  function notesByClip() {
    if (notesReadVer === notesVer) return notesBy
    notesReadVer = notesVer
    notesBy = new Map()
    for (const n of getNotes(doc)) {
      const a = notesBy.get(n.clipId)
      if (a) a.push(n)
      else notesBy.set(n.clipId, [n])
    }
    return notesBy
  }

  // --- static structure
  const laneBox = h('div', { className: 'lanes' })
  // Background menu "Upload": files go into the clicked track at the clicked position.
  let bgTarget: { trackId: string; at: number } | null = null
  const bgPicker = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  bgPicker.onchange = () => {
    const files = audioFiles(bgPicker.files)
    bgPicker.value = ''
    if (bgTarget && files.length) void st.dropFiles(files, bgTarget.trackId, bgTarget.at)
  }
  // New tracks: audio, an instrument (finnwave), drums (the first kit) or a soundscape. The new track is focused.
  const newTrack = (kind: 'audio' | 'instrument' | 'drums' | 'soundscape') => {
    st.undo.stopCapturing()
    let id = ''
    doc.transact(() => {
      if (kind === 'instrument') addDevice(doc, (id = st.addTrack('midi', st.trackName('instrument'))), FINNWAVE)
      else if (kind === 'drums') addDrumKit(doc, (id = st.addTrack('midi', st.trackName('drums'))), DRUM_KITS[0])
      else id = st.addTrack(kind)
    })
    st.undo.stopCapturing()
    st.focus(id)
    return id
  }
  const TRACK_KINDS = [
    { kind: 'audio', label: 'audio', icon: 'wave', title: 'an audio track, for recordings and samples' },
    { kind: 'instrument', label: 'instrument', icon: 'piano', title: 'an instrument track with a synth' },
    { kind: 'drums', label: 'drums', icon: 'drum', title: `a drum track with a kit (${DRUM_KITS[0].name})` },
    { kind: 'soundscape', label: 'soundscape', icon: 'loop', title: 'loopers over a source recording' },
  ] as const
  const addLink = h('button', { type: 'button', className: 'add-track', title: 'add a track', 'data-hint': 'add a track: audio, instrument, drums or a soundscape', onclick: () => {
    popover(addLink, TRACK_KINDS.map((k) => ({ label: k.label, icon: k.icon, title: k.title, run: () => void newTrack(k.kind) })))
  } }, icon('plus', 14), 'add track')
  const overlay = h('div', { className: 'overlay' })
  const playhead = h('div', { className: 'playhead' })
  const snapLine = h('div', { className: 'snap-line', hidden: true }) // where a dragged clip just snapped to
  const marquee = h('div', { className: 'marquee', hidden: true })
  overlay.append(playhead, snapLine)
  // The empty arrangement: what to do first.
  const hint = h('div', { className: 'arr-empty' },
    h('p', { className: 'arr-empty-title' }, readOnly ? 'Nothing here yet' : 'Drop audio files here, or add a track'),
    readOnly ? null : h('div', { className: 'arr-empty-btns' }, ...TRACK_KINDS.map((k) =>
      h('button', { type: 'button', className: 'btn', title: k.title, onclick: () => void newTrack(k.kind) }, icon(k.icon), k.label))),
    readOnly ? null : h('p', { className: 'arr-empty-sub dim' }, 'Sounds, instruments and effects from the browser can be dragged in too.'))
  // Tracks but no clips yet: a lighter version of the same, under the last track.
  const recordAudio = async () => {
    const id = newTrack('audio')
    await st.rec.arm(id)
    if (st.ui.armedTrack === id) st.status('Armed. Press record (⇧space) to start.')
  }
  const LITE = [
    { label: 'record audio', icon: 'record', title: 'a new audio track, armed for the microphone', run: () => void recordAudio() },
    { label: 'add an instrument', icon: 'piano', title: 'an instrument track with a synth', run: () => void newTrack('instrument') },
    { label: 'add drums', icon: 'drum', title: 'a drum track with a kit', run: () => void newTrack('drums') },
  ] as const
  const lite = h('div', { className: 'arr-lite', hidden: true },
    h('p', { className: 'arr-lite-sub dim' }, 'Next: double-click a lane for a clip, drag a sound in from the browser, or'),
    h('div', { className: 'arr-lite-btns' }, ...LITE.map((k) =>
      h('button', { type: 'button', className: 'btn', title: k.title, onclick: k.run }, icon(k.icon), k.label))))
  const masterAuto = makeAutoSection(MASTER_TRACK, 'global automation')
  // The master row: its header focuses the master bus (the dock shows its effects); the body shows its chain as chips.
  const masterHead = headers.master()
  const masterBody = h('div', { className: 'lane-body master-body' })
  masterBody.onclick = () => st.setUi({ focusTrack: MASTER_TRACK, dock: { ...st.ui.dock, open: true, tab: 'devices' } })
  const master = h('div', { className: 'lane master', 'data-hint': readOnly ? 'the master: effects on the whole mix' : 'the master: click to show the effects on the whole mix in the dock · drop an effect here' },
    h('div', { className: 'lane-row master-row' }, masterHead, masterBody))
  const tail = h('div', { className: 'arr-tail' }, readOnly ? null : addLink, readOnly ? null : lite)
  const el = h('div', { className: 'arr-lanes' }, master, laneBox, masterAuto.el, hint, tail, bgPicker, overlay, marquee)
  const heights = heightsFor(st)
  const parts = new Map<string, Parts>()

  const x = (smp: number) => st.x(smp)
  const rate = () => st.rate
  const position = () => st.position()

  // --- takes in progress and the loop pedal, drawn into their lanes
  /** The take so far, drawn into its growing region (the visible part only). */
  function drawLiveWave(region: HTMLElement, startPx: number, widthPx: number) {
    const pb = st.pb
    if (!pb) return
    let cv = region.querySelector('canvas')
    if (!cv) region.prepend((cv = h('canvas', { className: 'wave' })))
    const viewW = scroll.clientWidth || innerWidth
    const left = HEADER + startPx // region's left edge in scroller-content px
    const v0 = Math.max(0, Math.floor(scroll.scrollLeft + HEADER - left)), v1 = Math.min(Math.ceil(widthPx), Math.ceil(scroll.scrollLeft + viewW - left))
    if (v1 <= v0) { cv.style.display = 'none'; return }
    const dpr = window.devicePixelRatio || 1
    cv.style.display = ''
    cv.style.left = `${v0}px`
    cv.style.width = `${v1 - v0}px`
    cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
    cv.height = Math.round(Math.max(1, region.clientHeight) * dpr)
    const fpp = rate() / st.ui.pps // frames per css px
    drawWave(cv, pb.recorder.peaks, v0 * fpp, (v1 - v0) * fpp)
  }

  /** The growing regions of takes in progress: ours, and other people's (from their awareness). */
  function drawRecRegions() {
    const want = new Map<string, { trackId: string; start: number; end: number; label: string }>()
    const take = st.rec.take
    if (take) want.set('me', { trackId: take.trackId, start: take.start, end: position(), label: 'recording' })
    for (const r of st.remote) {
      if (r.recording) want.set(`${r.user.username}:${r.recording.trackId}`, { ...r.recording, end: r.playhead ?? r.recording.start, label: `${r.user.username} is recording` })
    }
    for (const [k, e] of recRegions) if (!want.has(k)) { e.remove(); recRegions.delete(k) }
    for (const [k, w] of want) {
      const body = lanes.get(w.trackId)?.body
      if (!body) continue
      let e = recRegions.get(k)
      if (!e) recRegions.set(k, (e = h('div', { className: 'clip recording' }, w.label)))
      if (e.parentElement !== body) body.append(e)
      e.style.left = `${x(w.start)}px`
      const width = Math.max(2, x(Math.max(w.start, w.end) - w.start))
      e.style.width = `${width}px`
      if (k === 'me') drawLiveWave(e, x(w.start), width)
    }
  }

  /** The pedal's layer and loops, drawn into their lanes like the take in progress. */
  function drawPedal() {
    const v = st.pedal.view()
    const want = new Map<string, { trackId: string; start: number; end: number; pass: number; cls: string; label: string }>()
    const now = position()
    if (v?.layer) want.set('layer', { trackId: v.layer.trackId, start: v.layer.start, end: now, pass: 0, cls: 'clip recording', label: 'recording' })
    for (const l of v?.loops ?? []) {
      // a loop with no end is drawn to the seam after the playhead, so its leading edge stays ahead of it
      const end = l.stopAt ?? l.start + Math.max(1, Math.ceil((now - l.start) / l.pass)) * l.pass
      want.set(`loop:${l.id}`, { trackId: l.trackId, start: l.start, end, pass: l.pass, cls: `clip live-loop${l.stopAt == null ? ' forever' : ''}`, label: `loop ${l.id}` })
    }
    for (const [k, e] of pedalEls) if (!want.has(k)) { e.remove(); pedalEls.delete(k) }
    for (const [k, w] of want) {
      const body = lanes.get(w.trackId)?.body
      if (!body) continue
      let e = pedalEls.get(k)
      if (!e) pedalEls.set(k, (e = h('div', { className: w.cls }, h('i', { className: 'seams' }), h('span', { className: 'label' }, w.label))))
      if (e.parentElement !== body) body.append(e)
      const width = x(Math.max(0, w.end - w.start))
      e.hidden = width < 1
      e.style.left = `${x(w.start)}px`
      e.style.width = `${width}px`
      const seams = e.firstElementChild as HTMLElement
      const pass = x(w.pass)
      seams.style.display = w.pass && width > pass ? '' : 'none'
      seams.style.left = `${pass}px`
      seams.style.width = `${Math.max(0, width - pass)}px`
      seams.style.backgroundSize = `${pass}px 100%`
    }
  }

  function drawPlayhead(p = position()) {
    playhead.style.left = `${HEADER + x(p)}px`
    drawRecRegions()
    drawPedal()
    // what the automation drives, on the looper cards
    for (const l of lanes.values()) for (const [id, c] of l.loopCards) if (st.auto.infos.has(id)) c.refresh(st.auto.info(id))
  }

  // --- automation: lanes (one per automated param) live in a collapsible section per track, and one for the global fx
  const rowDeps = { doc, readOnly, grab: () => undo.stopCapturing(), x, fromX: (px: number) => st.fromX(px),
    snap: (smp: number, ev: { altKey: boolean; ctrlKey: boolean; metaKey?: boolean }) => st.snap(smp, { altKey: ev.altKey, ctrlKey: ev.ctrlKey || !!ev.metaKey }),
    get rate() { return st.rate } }

  function makeAutoSection(scope: string, title = 'automation'): AutoSec {
    const toggle = h('button', { className: 'fx-toggle', title: 'automation lanes', onclick: () => {
      const open = st.ui.autoOpen
      st.setUi({ autoOpen: open.includes(scope) ? open.filter((x) => x !== scope) : [...open, scope] })
    } }, title)
    const box = h('div', { className: 'auto-box' })
    const el = h('div', { className: 'auto-section', hidden: true }, h('div', { className: 'fx-row' }, toggle), box)
    el.dataset.title = title
    return { el, toggle, box, rows: new Map() }
  }

  /** The owner's name for a lane header: the device's, numbered when its chain has several of a kind. */
  function ownerLabel(l: AutoLane, base: string, devices: Device[]) {
    if (l.kind === 'looper') return base
    const same = devices.filter((d) => d.trackId === l.scope && DEVICES[d.type]?.name === base)
    return same.length > 1 ? `${base} ${same.findIndex((d) => d.id === l.owner) + 1}` : base
  }

  /** Sync every scope's section with the lanes in the doc. */
  function drawAutomation(devices: Device[], loopers: Looper[], width: number) {
    const byScope = new Map<string, AutoLane[]>()
    for (const l of st.auto.lanes) (byScope.get(l.scope) ?? byScope.set(l.scope, []).get(l.scope)!).push(l)
    const sections: [string, AutoSec][] = [[MASTER_TRACK, masterAuto], ...[...lanes].map(([id, l]) => [id, l.auto] as [string, AutoSec])]
    const shown = new Set(st.ui.autoOpen)
    for (const [scope, sec] of sections) {
      const mine = (byScope.get(scope) ?? []).flatMap((l) => {
        const r = resolveTarget(doc, l)
        return r ? [{ l, r }] : []
      })
      sec.el.hidden = mine.length === 0
      const open = shown.has(scope)
      sec.toggle.classList.toggle('on', open)
      sec.toggle.textContent = `${sec.el.dataset.title} (${mine.length})`
      sec.box.hidden = !open
      const ids = new Set(mine.map((m) => m.l.id))
      for (const [id, row] of sec.rows) if (!ids.has(id)) { row.el.remove(); sec.rows.delete(id) }
      if (!open) continue
      mine.forEach(({ l, r }, i) => {
        let row = sec.rows.get(l.id)
        if (!row) sec.rows.set(l.id, (row = autoRow(rowDeps)))
        if (sec.box.children[i] !== row.el) sec.box.insertBefore(row.el, sec.box.children[i] ?? null)
        const slot = l.kind === 'looper' ? loopers.find((x) => x.id === l.owner)?.slot : undefined
        row.update(l, st.auto.points.get(l.id) ?? [], {
          def: r.def, label: `${ownerLabel(l, r.owner, devices)} · ${r.label}`, value: r.value, width,
          color: slot != null ? LOOP_COLORS[slot % LOOP_COLORS.length] : 'var(--accent)',
        })
      })
      if (open && !autoShownBefore.has(scope)) sec.el.scrollIntoView({ block: 'nearest' }) // just revealed
    }
    autoShownBefore = shown
  }

  // --- lanes
  function laneFor(t: Track): Lane {
    let l = lanes.get(t.id)
    if (l) return l
    const body = h('div', { className: 'lane-body', 'data-track': t.id })
    if (!readOnly) body.dataset.hint = t.kind === 'audio' ? 'arm the track and press record, or drop an audio file here · drag: select clips'
      : t.kind === 'midi' ? 'double-click: new clip · right-click: piano roll or drum grid · drop a sound here · drag: select clips'
      : 'right-click: new region (the loopers play during it) · drag: select'
    // empty space: a drag draws a selection box (shift adds to the selection); a click selects nothing and focuses the track
    body.addEventListener('pointerdown', (e) => {
      if (e.target !== body || e.button !== 0 || st.ui.looperArm) return
      marqueeDown(e, t.id)
    })
    const atX = (e: MouseEvent) => st.snap(st.fromX(e.clientX - body.getBoundingClientRect().left), e)
    body.ondblclick = (e) => { // empty space on a MIDI lane: a new clip, opened in the dock
      if (readOnly || e.target !== body || t.kind !== 'midi') return
      const cur = tracksMap(doc).get(t.id)?.toJSON() as Track | undefined
      st.newMidiClip(t.id, atX(e), !!cur && kindOf(doc, cur).kind === 'drums') // a drum track's clips are drum grids
    }
    // background menu: audio lanes take uploads; MIDI lanes and soundscapes make a new region; any lane can paste
    const paste = (e: MouseEvent): MenuItem[] => clipboard.get() ? ['sep', { label: 'paste here', icon: 'duplicate', hint: IS_MAC ? '⌘V' : 'ctrl+V', run: () => {
      st.undo.stopCapturing()
      const ids = pasteClips(doc, clipboard.get()!, { at: atX(e), trackId: t.id })
      st.undo.stopCapturing()
      if (ids.length) st.select(ids)
    } }] : []
    const trackItems = (e: MouseEvent): MenuItem[] => ['sep', { label: 'track…', icon: 'more', run: () => headers.menu(t.id, [e.clientX, e.clientY]) }]
    if (t.kind === 'audio') bgMenu(body, (e) => [{ label: 'upload audio', icon: 'upload', run: () => pickInto(t.id, st.fromX(e.clientX - body.getBoundingClientRect().left)) }, ...paste(e), ...trackItems(e)])
    else if (t.kind === 'midi') bgMenu(body, (e) => [{ label: 'new piano roll', icon: 'piano', run: () => st.newMidiClip(t.id, atX(e)) }, { label: 'new drum grid', icon: 'drum', run: () => st.newMidiClip(t.id, atX(e), true) }, ...paste(e), ...trackItems(e)])
    else if (t.kind === 'soundscape') bgMenu(body, (e) => [{ label: 'new region', icon: 'plus', run: () => st.newPad(t.id, atX(e)) }, ...trackItems(e)])
    // soundscape tracks: the main lane is blank like an empty track (regions turn the loopers on); the source audio gets its own lane
    const src: Src | null = t.kind === 'soundscape' ? sourceLane(t.id) : null
    // the loopers row: speed and region per slot
    const loopMore = h('button', { className: 'fx-toggle', title: 'loopers', onclick: () => {
      if (loopShown.delete(t.id)) {
        const pv = st.pb?.preview(t.id, 'loops') // the transport is about to be hidden: don't leave it playing
        if (pv?.playing) pv.stop()
      } else loopShown.add(t.id)
      draw()
    } }, 'loopers')
    const loops = h('div', { className: 'fx' })
    loops.append(h('button', { className: 'add-fx', title: 'add looper', disabled: readOnly, onclick: () => addNextLooper(doc, t.id) }, '+'))
    const loopTc = transportControls({ title: 'play / stop the loops', small: true, onToggle: () => togglePreview(t.id, 'loops') })
    const loopRow = h('div', { className: 'fx-row', hidden: true }, h('div', { className: 'fx-head' }, loopMore, loopTc.el), loops)
    const row = h('div', { className: 'lane-row' }, headers.headFor(t), body)
    acceptDrops(row, t.id, body)
    const auto = makeAutoSection(t.id)
    l = {
      el: h('div', { className: 'lane' }, row, src?.row ?? null, loopRow, auto.el), row, body,
      loopMore, loopRow, loops, loopCards: new Map(), boxes: new Map(), heads: new Map(), pads: new Map(), auto, loopTc, src,
    }
    lanes.set(t.id, l)
    headers.attach(t, l.el)
    return l
  }

  // --- soundscape previews: each soundscape's source and loops have a private transport/playhead
  function togglePreview(trackId: string, mode: PreviewMode) {
    const pv = st.pb?.preview(trackId, mode)
    if (!pv) return
    if (pv.playing) pv.stop()
    else {
      const end = lanes.get(trackId)?.src?.end ?? 0
      // loops always start from their beginning; the source resumes unless it already ran out
      pv.play(mode === 'loops' || pv.position() >= end ? 0 : undefined)
    }
    refreshPreviews()
    ensurePreviewTick()
  }

  /** One thin playhead per sounding looper, in source time over the source audio. */
  function drawLoopHeads(): boolean {
    let shown = false
    for (const [trackId, l] of lanes) {
      if (!l.src) continue
      const live = new Set<string>()
      for (const lp of getLoopers(doc)) {
        const pos = lp.trackId === trackId ? st.pb?.looperHead(lp.id) : null
        if (pos == null) continue
        shown = true
        live.add(lp.id)
        let e = l.heads.get(lp.id)
        if (!e) {
          e = h('div', { className: 'loop-head' })
          e.style.setProperty('--c', LOOP_COLORS[lp.slot % LOOP_COLORS.length])
          l.heads.set(lp.id, e)
          l.src.body.append(e)
        }
        e.style.left = `${(pos / rate()) * l.src.pps}px`
      }
      for (const [id, e] of l.heads) if (!live.has(id)) { e.remove(); l.heads.delete(id) }
    }
    return shown
  }
  /** Sync transport buttons, times and playheads with the previews; true while any is playing. */
  function refreshPreviews(): boolean {
    const pb = st.pb
    if (!pb) return false
    let any = false
    for (const [id, l] of lanes) {
      if (!l.src) continue
      const src = pb.preview(id, 'source'), loops = pb.preview(id, 'loops')
      if (src.playing && src.position() > l.src.end) src.stop() // ran off the end of the audio
      const sp = src.position(), lp = loops.position()
      l.src.tc.setPlaying(src.playing)
      l.src.tc.setTime(sp / rate())
      l.src.playhead.hidden = !src.playing && sp === 0
      l.src.playhead.style.left = `${(sp / rate()) * l.src.pps}px`
      l.loopTc.setPlaying(loops.playing)
      l.loopTc.setTime(lp / rate())
      any ||= src.playing || loops.playing
    }
    return drawLoopHeads() || any || pb.playing // (the heads keep drawing until the engine reports them gone)
  }
  let previewRaf = 0
  function ensurePreviewTick() {
    if (!previewRaf) previewRaf = requestAnimationFrame(previewTick)
  }
  function previewTick() {
    previewRaf = 0
    if (!destroyed && refreshPreviews()) ensurePreviewTick()
  }

  // --- soundscape: source lane (own time world) and region blocks (timeline-anchored gates)
  const srcEnd = (trackId: string) =>
    Math.max(0, ...getClips(doc).filter((c) => c.trackId === trackId).map((c) => c.start + clipLength(c, rate())))

  /**
   * Right-click on a lane's empty background opens a menu of `entries(event)` at the cursor (upload for lanes that hold
   * audio, new clips for MIDI lanes, a region for soundscapes, paste). A left press is the selection box.
   */
  function bgMenu(body: HTMLElement, entries: (e: MouseEvent) => MenuItem[]) {
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!readOnly && e.target === body) popover(body, entries(e), [e.clientX, e.clientY])
    })
  }

  // --- selection box: drag on empty lane space; clips it touches are selected (shift: added to the selection)
  function marqueeDown(e: PointerEvent, trackId: string | null) {
    e.preventDefault()
    // the arrangement has the keys now: let go of the dock's editor (its focus and note selection)
    const active = document.activeElement as HTMLElement | null
    if (active?.closest('.dock')) active.blur()
    if (st.ui.note) st.setUi({ note: null })
    const base = e.shiftKey ? [...st.ui.selection] : []
    const box0 = el.getBoundingClientRect()
    const x0 = e.clientX - box0.left, y0 = e.clientY - box0.top
    let drew = false
    dragPointer(e, {
      onDrag: (m) => {
        const r = el.getBoundingClientRect()
        const x1 = m.clientX - r.left, y1 = m.clientY - r.top
        if (!drew && Math.hypot(x1 - x0, y1 - y0) < 4) return
        drew = true
        const left = Math.min(x0, x1), top = Math.min(y0, y1), w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0)
        Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${hh}px` })
        marquee.hidden = false
        const sel = new Set(base)
        const cl = r.left + left, ct = r.top + top, cr = cl + w, cb = ct + hh
        for (const [id, ce] of clipEls) {
          if (!ce.isConnected || ce.closest('.src-body')) continue // source clips have their own time
          const b = ce.getBoundingClientRect()
          if (b.right > cl && b.left < cr && b.bottom > ct && b.top < cb) sel.add(id)
        }
        const next = [...sel]
        if (next.length !== st.ui.selection.length || next.some((id, i) => st.ui.selection[i] !== id)) st.setUi({ selection: next })
      },
      onEnd: () => {
        marquee.hidden = true
        if (drew) return
        st.setUi({ selection: e.shiftKey ? st.ui.selection : [], pad: null, ...(trackId ? { focusTrack: trackId } : {}) })
      },
    })
  }

  // --- drops: browser payloads (instruments, kits, effects, project audio) and audio files, on a lane or below them
  /** The payload being dragged, read when its drag starts (dragover can only see its type). */
  let dragging: DropPayload | null = null
  const onDragStart = (e: DragEvent) => { dragging = hasPayload(e) ? readDragPayload(e) : null }
  const onDragEnd = () => { dragging = null; clearDrop() }
  addEventListener('dragstart', onDragStart)
  addEventListener('dragend', onDragEnd)
  addEventListener('drop', onDragEnd)
  let dropLane: HTMLElement | null = null
  let dropTimer = 0
  function clearDrop() {
    dropLane?.classList.remove('drop-ok', 'drop-no')
    dropLane = null
  }
  /** Mark `lane` as the drop target (ok or refused) until the drag moves on. */
  function markDrop(lane: HTMLElement | null, ok: boolean) {
    if (dropLane !== lane) clearDrop()
    dropLane = lane
    lane?.classList.toggle('drop-ok', ok)
    lane?.classList.toggle('drop-no', !ok)
    clearTimeout(dropTimer)
    dropTimer = window.setTimeout(clearDrop, 150) // (dragover repeats while the pointer stays)
  }
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
  /** Drops on a track's row (header and body): `body` gives the timeline position when the pointer is over it. */
  function acceptDrops(row: HTMLElement, trackId: string, body: HTMLElement) {
    const kind = () => tracksMap(doc).get(trackId)?.get('kind')
    const at = (e: DragEvent) => {
      const r = body.getBoundingClientRect()
      return e.clientX >= r.left ? st.fromX(e.clientX - r.left) : Math.round(st.position())
    }
    row.addEventListener('dragover', (e) => {
      const files = hasFiles(e), payload = hasPayload(e)
      if (!files && !payload) return
      e.stopPropagation()
      const ok = !readOnly && !st.locks.has(trackId) && (payload ? !dragging || canDrop(st, dragging, trackId) : kind() === 'audio')
      markDrop(row.closest('.lane') as HTMLElement, ok)
      if (!ok) { if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; return }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      clearDrop()
      if (readOnly) return
      const p = hasPayload(e) ? readDragPayload(e) : null
      if (p) {
        if (canDrop(st, p, trackId)) applyDrop(st, p, { trackId, at: at(e) })
        return
      }
      void st.dropFiles([...(e.dataTransfer?.files ?? [])], kind() === 'audio' ? trackId : null, st.snap(at(e), e))
    })
  }
  // below the tracks (and the empty arrangement): a new track for whatever is dropped
  el.addEventListener('dragover', (e) => {
    if (!hasPayload(e) && !hasFiles(e)) return
    if (readOnly) return
    e.preventDefault()
    markDrop(tail, true)
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  })
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation() // (the scroller would import the files again)
    clearDrop()
    if (readOnly) return
    const at = st.snap(st.fromX(e.clientX - el.getBoundingClientRect().left - HEADER), e)
    const p = hasPayload(e) ? readDragPayload(e) : null
    if (p) applyDrop(st, p, { trackId: null, at })
    else void st.dropFiles([...(e.dataTransfer?.files ?? [])], null, at)
  })
  // the empty space below the tracks is a selection box too, across every lane
  tail.addEventListener('pointerdown', (e) => { if (e.target === tail && e.button === 0) marqueeDown(e, null) })

  /** Pick audio files and import them into `trackId` starting at sample `at` of that lane's time scale. */
  function pickInto(trackId: string, at: number) {
    bgTarget = { trackId, at }
    bgPicker.click()
  }

  function sourceLane(trackId: string): Src {
    const ticks = h('div', { className: 'src-ticks' })
    const body = h('div', { className: 'lane-body src-body', 'data-track': trackId }, ticks)
    const view = h('div', { className: 'src-view' }, body)
    const tc = transportControls({ title: 'play / pause the source audio', small: true, onToggle: () => togglePreview(trackId, 'source') })
    const more = h('button', { className: 'fx-toggle', title: 'source audio', onclick: () => {
      if (srcShown.delete(trackId)) {
        const pv = st.pb?.preview(trackId, 'source') // the transport is about to be hidden: don't leave it playing
        if (pv?.playing) pv.stop()
      } else srcShown.add(trackId)
      draw()
    } }, 'source')
    const head = h('div', { className: 'head src-head' }, more, tc.el)
    const playhead = h('div', { className: 'playhead', hidden: true })
    body.append(playhead)
    const src: Src = { row: h('div', { className: 'lane-row src-row' }, head, view), view, body, ticks, pps: 80, more, tc, playhead, end: 0 }
    const srcAt = (cx: number) => Math.max(0, Math.round(((cx - body.getBoundingClientRect().left) / src.pps) * rate()))
    // click or drag on the source ruler to move its playhead (the main transport is unaffected)
    ticks.onpointerdown = (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const seek = (cx: number) => {
        st.pb?.preview(trackId, 'source').seek(srcAt(cx))
        refreshPreviews()
      }
      seek(e.clientX)
      dragPointer(e, { onDrag: (m) => seek(m.clientX), onEnd: () => {} })
    }
    body.onpointerdown = (e) => {
      if (e.target !== body) return
      st.setUi({ selection: [], pad: null })
    }
    body.ondragover = (e) => e.preventDefault()
    body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      void st.dropFiles([...(e.dataTransfer?.files ?? [])], trackId, srcAt(e.clientX))
    }
    bgMenu(body, (e) => [['upload', () => pickInto(trackId, srcAt(e.clientX))]])
    view.addEventListener('scroll', schedule, { passive: true })
    view.addEventListener('wheel', (e) => { // zoom this lane only
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      const t = (e.clientX - body.getBoundingClientRect().left) / src.pps
      src.pps = clamp(src.pps * Math.exp(-e.deltaY * 0.01), 10, 800)
      draw()
      view.scrollLeft += t * src.pps - (e.clientX - view.getBoundingClientRect().left) - view.scrollLeft
    }, { passive: false })
    // while a looper is armed, a drag here draws its region (capture: clips must not start a drag)
    body.addEventListener('pointerdown', (e) => {
      const lp = st.ui.looperArm ? getLoopers(doc).find((x) => x.id === st.ui.looperArm && x.trackId === trackId) : undefined
      if (!lp || readOnly || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      drawRegion(e, lp, src)
    }, true)
    return src
  }

  /** Move, or trim either edge of, a soundscape region (the same controls as an audio clip). */
  function padDown(ev: PointerEvent, id: string) {
    if (ev.button !== 0) return
    const pad = getPads(doc).find((p) => p.id === id)
    if (!pad) return
    const mode = grabAt(ev.clientX, (ev.currentTarget as HTMLElement).getBoundingClientRect())
    st.setUi({ pad: id, selection: [], note: null })
    if (readOnly) return
    undo.stopCapturing()
    ev.preventDefault()
    dragPointer(ev, {
      onDrag: (m) => {
        if (!padsMap(doc).has(id)) return
        const dSmp = Math.round(((m.clientX - ev.clientX) / st.ui.pps) * rate())
        if (mode === 'move') updatePad(doc, id, { start: st.snap(Math.max(0, pad.start + dSmp), m) })
        else {
          const t = trimBlock(mode, pad, dSmp, { minLength: MIN_SEC * rate(), slackLeft: pad.start })
          updatePad(doc, id, { start: t.start, length: t.length })
        }
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  function drawPads(l: Lane, t: Track, pads: Pad[]) {
    const mine = t.kind === 'soundscape' ? pads.filter((p) => p.trackId === t.id) : []
    const ids = new Set(mine.map((p) => p.id))
    for (const [id, e] of l.pads) if (!ids.has(id)) { e.remove(); l.pads.delete(id) }
    for (const p of mine) {
      let e = l.pads.get(p.id)
      if (!e) {
        e = h('div', { className: 'clip region' }, 'loopers on') // a clip-styled block: same edges, same hover
        e.onpointerdown = (ev) => padDown(ev, p.id)
        deleteMenu(e, 'delete region', () => { deletePad(doc, p.id); if (st.ui.pad === p.id) st.setUi({ pad: null }) }, () => !readOnly)
        l.pads.set(p.id, e)
        l.body.append(e)
      }
      e.style.left = `${x(p.start)}px`
      e.style.width = `${Math.max(2, x(p.length))}px`
      e.classList.toggle('sel', p.id === st.ui.pad)
    }
  }

  const loopDeps = {
    readOnly,
    grab: () => undo.stopCapturing(),
    commit: (id: string, speed: number) => updateLooper(doc, id, { speed }),
    setMuted: (id: string, muted: boolean) => updateLooper(doc, id, { muted }),
    setGain: (id: string, gain: number) => updateLooper(doc, id, { gain }),
    setTape: (id: string, patch: { sat?: number; cutoff?: number; warble?: number }) => updateLooper(doc, id, patch),
    autoMenu: (label: HTMLElement, t: ParamTarget) => st.autoMenu(label, t),
    toggleArm: (id: string) => st.setUi({ looperArm: st.ui.looperArm === id ? null : id }),
    clear: (id: string) => updateLooper(doc, id, { start: 0, length: 0 }),
    remove: (id: string) => { if (st.ui.looperArm === id) st.setUi({ looperArm: null }); deleteLooper(doc, id) },
  }

  /** Looper rows (cards) and the coloured region boxes drawn over the track's audio. */
  function drawLoopers(l: Lane, t: Track, loopers: Looper[]) {
    const armed = st.ui.looperArm
    const isLoop = t.kind === 'soundscape' && !!l.src
    l.loopRow.hidden = !isLoop
    const open = isLoop && loopShown.has(t.id)
    const mine = isLoop ? loopers.filter((x) => x.trackId === t.id) : []
    const shown = open || mine.length > 0 // shut: the cards stay as title bars
    l.loops.hidden = !shown
    l.loops.classList.toggle('collapsed', !open)
    l.loopMore.classList.toggle('on', open)
    l.loopTc.el.hidden = !open
    l.src?.body.classList.toggle('arming', mine.some((x) => x.id === armed))
    // region boxes
    const ids = new Set(mine.filter((x) => x.length > 0).map((x) => x.id))
    for (const [id, b] of l.boxes) if (!ids.has(id)) { b.remove(); l.boxes.delete(id) }
    for (const lp of mine) {
      if (lp.length <= 0 || !l.src) continue
      let b = l.boxes.get(lp.id)
      if (!b) {
        b = h('div', { className: 'loop-box' }, h('span', {}, String(lp.slot + 1)))
        b.style.setProperty('--c', LOOP_COLORS[lp.slot % LOOP_COLORS.length])
        l.boxes.set(lp.id, b)
        const id = lp.id
        b.onpointerdown = (ev) => loopBoxDown(ev, id, b!)
        l.src.body.append(b) // regions live in source time, over the source audio
      }
      b.style.left = `${(lp.start / rate()) * l.src.pps}px`
      b.style.width = `${Math.max(2, (lp.length / rate()) * l.src.pps)}px`
      b.classList.toggle('armed', lp.id === armed)
    }
    if (!shown) return
    for (const [id, c] of l.loopCards) if (!mine.some((m) => m.id === id)) { c.el.remove(); l.loopCards.delete(id) }
    mine.forEach((lp, i) => {
      let c = l.loopCards.get(lp.id)
      if (!c) l.loopCards.set(lp.id, (c = looperCard(lp, loopDeps)))
      if (l.loops.children[i] !== c.el) l.loops.insertBefore(c.el, l.loops.children[i] ?? null)
      c.update(lp, lp.id === armed, rate(), st.auto.info(lp.id))
    })
  }

  /** Drag a loop window to move it, or either edge to resize it (live in the doc, one undo step). */
  function loopBoxDown(ev: PointerEvent, id: string, box: HTMLElement) {
    if (ev.button !== 0) return
    ev.stopPropagation()
    const lp = getLoopers(doc).find((x) => x.id === id)
    const l = lp && lanes.get(lp.trackId)
    if (!lp || !l?.src || readOnly || st.ui.looperArm) return
    ev.preventDefault()
    const mode = grabAt(ev.clientX, box.getBoundingClientRect())
    const pps = l.src.pps
    const min = Math.round(MIN_SEC * rate())
    const end = lp.start + lp.length
    undo.stopCapturing()
    dragPointer(ev, {
      onDrag: (m) => {
        const d = Math.round(((m.clientX - ev.clientX) / pps) * rate())
        if (mode === 'move') updateLooper(doc, id, { start: Math.max(0, lp.start + d) })
        else if (mode === 'l') {
          const start = clamp(lp.start + d, 0, end - min)
          updateLooper(doc, id, { start, length: end - start })
        } else updateLooper(doc, id, { length: Math.max(min, lp.length + d) })
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  /** Drag across a lane to set a looper's region (live in the doc, one undo step). */
  function drawRegion(ev: PointerEvent, lp: Looper, src: Src) {
    const at = (cx: number) => Math.max(0, Math.round(((cx - src.body.getBoundingClientRect().left) / src.pps) * rate()))
    let drew = false
    undo.stopCapturing()
    dragPointer(ev, {
      onDrag: (m) => {
        if (Math.abs(m.clientX - ev.clientX) < 4) return // a click doesn't erase the old region
        drew = true
        const a = at(ev.clientX), b = at(m.clientX)
        updateLooper(doc, lp.id, { start: Math.min(a, b), length: Math.abs(b - a) })
      },
      onEnd: () => {
        undo.stopCapturing()
        if (drew) st.setUi({ looperArm: null })
      },
    })
  }

  // --- drawing (keyed reuse)
  function schedule() {
    if (!raf && !destroyed) raf = requestAnimationFrame(() => ((raf = 0), draw()))
  }

  function draw() {
    if (destroyed) return
    const rt = rate()
    const tracks = getTracks(doc)
    const clips = getClips(doc)
    const devices = getDevices(doc)
    const loopers = getLoopers(doc)
    const pads = getPads(doc)
    const notes = notesByClip()
    const samples = getSamples(doc)
    const total = st.extent()
    const { selection, editing } = st.ui
    // read the scrollers' metrics once, before this draw writes any style (reading them after a write forces a layout,
    // which was once per audio clip)
    const view = { w: scroll.clientWidth || innerWidth, left: scroll.scrollLeft, h: scroll.clientHeight }
    const srcViews = new Map<string, { w: number; left: number }>()
    for (const [id, l] of lanes) if (l.src) srcViews.set(id, { w: l.src.view.clientWidth || innerWidth, left: l.src.view.scrollLeft })
    scroll.style.setProperty('--view', `${view.w}px`)
    el.style.width = `${HEADER + x(total)}px`

    // the master row
    const fx = devices.filter((d) => d.trackId === MASTER_TRACK)
    masterHead.classList.toggle('focus', st.ui.focusTrack === MASTER_TRACK)
    const chips = fx.map((d) => `${d.bypass ? '~' : ''}${d.name ?? DEVICES[d.type]?.name ?? ''}`)
    const chipSig = chips.join('|') || '-'
    if (masterBody.dataset.sig !== chipSig) {
      masterBody.dataset.sig = chipSig
      masterBody.replaceChildren(...(fx.length
        ? fx.map((d) => h('span', { className: `chip master-chip${d.bypass ? ' off' : ''}`, title: d.bypass ? 'bypassed' : 'click to show the master effects' }, icon('effect', 12), d.name ?? DEVICES[d.type]?.name ?? ''))
        : [h('span', { className: 'dim' }, readOnly ? 'no effects on the mix' : 'no effects on the mix: click to add one, or drop one here')]))
    }

    // lanes
    hint.hidden = tracks.length > 0
    el.classList.toggle('empty', tracks.length === 0)
    tail.hidden = tracks.length === 0
    lite.hidden = readOnly || tracks.length === 0 || clips.length > 0 || pads.length > 0
    // what a MIDI clip without a name of its own is called: its track's instrument (a synth), else the track
    const midiLabel = new Map(tracks.filter((t) => t.kind === 'midi').map((t) => {
      const inst = kindOf(doc, t, devices, clips).kind === 'instrument'
        ? devices.find((d) => d.trackId === t.id && DEVICES[d.type]?.instrument && !isDrum(d)) : undefined
      return [t.id, (inst && (inst.name || DEVICES[inst.type]?.name)) || t.name] as const
    }))
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, l] of lanes) if (!ids.has(id)) { l.el.remove(); lanes.delete(id) }
    tracks.forEach((t, i) => {
      const l = laneFor(t)
      if (laneBox.children[i] !== l.el) laneBox.insertBefore(l.el, laneBox.children[i] ?? null)
      l.body.style.width = `${x(total)}px`
      const rowH = heights.get(t.id)
      if (l.row.style.height !== `${rowH}px`) l.row.style.height = `${rowH}px`
      l.el.classList.toggle('short', rowH < 56)
      l.el.dataset.kind = t.kind
      l.el.style.setProperty('--tc', trackColor(t, i))
      l.el.classList.toggle('focus', st.ui.focusTrack === t.id)
      l.el.classList.toggle('locked', st.locks.has(t.id))
      l.el.classList.toggle('muted', t.muted)
      drawLoopers(l, t, loopers)
      drawPads(l, t, pads)
      if (l.src) {
        const srcOpen = srcShown.has(t.id)
        l.src.row.classList.toggle('collapsed', !srcOpen) // collapsed: just the clip names
        l.src.more.classList.toggle('on', srcOpen)
        l.src.tc.el.hidden = !srcOpen
        l.src.end = srcEnd(t.id)
        const end = Math.max(60 * rt, l.src.end + 30 * rt)
        l.src.body.style.width = `${(end / rt) * l.src.pps}px`
        drawTicks(l.src.ticks, end / rt, l.src.pps)
      }
    })

    drawAutomation(devices, loopers, x(total))

    // clips
    const outline = new Map<string, string>()
    for (const r of st.remote) for (const id of r.selection ?? []) outline.set(id, r.user.color)
    const cids = new Set(clips.map((c) => c.id))
    for (const [id, e] of clipEls) if (!cids.has(id)) { e.remove(); clipEls.delete(id); waves.delete(id); parts.delete(id) }
    for (const c of clips) {
      const lane = lanes.get(c.trackId)
      if (!lane) continue
      let e = clipEls.get(c.id)
      if (!e) e = makeClip(c)
      const host = lane.src ? lane.src.body : lane.body // source clips are drawn in the source lane's own scale
      const cpps = lane.src ? lane.src.pps : st.ui.pps
      const bodyH = Math.max(4, (lane.src ? SRC_H - 14 : heights.get(c.trackId)) - 2 * CLIP_INSET - CLIP_HEAD)
      const pt = parts.get(c.id)!
      if (e.parentElement !== host) host.append(e)
      e.style.left = `${(c.start / rt) * cpps}px`
      // a `forever` clip is drawn out to the end of the scroll area, which its finite part alone decides
      const forever = isForever(c)
      const width = Math.max(2, ((forever ? Math.max(clipLength(c, rt), total - c.start) : clipLength(c, rt)) / rt) * cpps)
      e.style.width = `${width}px`
      e.classList.toggle('forever', forever)
      e.classList.toggle('looping', isLooping(c))
      e.classList.toggle('loopable', !readOnly && !lane.src && !st.locks.has(c.trackId))
      let canPlay = true
      if (c.kind === 'audio') {
        const meta = samples[c.sourceHash]
        canPlay = !!meta && playable(meta)
        const status = meta?.status // incoming and missing audio is drawn from the stored peaks (docs/engine.md §9.3)
        const own = c.name || meta?.name
        let label = meta ? (canPlay ? own! : `${own} · too long to play yet`) : c.name || '…'
        if (status === 'incoming') label = `${own} · ${incomingLabel(meta)}`
        else if (status === 'missing') label = `${own} · audio deleted`
        e.classList.toggle('incoming', status === 'incoming')
        e.classList.toggle('missing', status === 'missing')
        const w = waves.get(c.id)!
        if (w.label.textContent !== label) (w.label.textContent = label), (pt.head.title = label)
        drawSeams(c, w, width, cpps)
        drawFades(c, w, width, bodyH, cpps, !lane.src && !readOnly && !st.locks.has(c.trackId))
        const pk = !st.pb || !canPlay ? undefined : status ? storedPeaks(meta, rt) : peaksFor(s.projectId, c.sourceHash, rt)
        const sv = lane.src ? srcViews.get(c.trackId) ?? { w: lane.src.view.clientWidth || innerWidth, left: lane.src.view.scrollLeft } : view
        if (pk) drawVisibleWave(c, w, pk, width, bodyH, { pps: cpps, viewW: sv.w, scrollLeft: sv.left, off: lane.src ? 0 : HEADER })
        else w.cv.style.display = 'none'
      } else drawMidiClip(pt, c, notes.get(c.id) ?? [], forever ? (width / cpps) * c.bpm * c.ppq / 60 : c.lengthTicks, c.name || midiLabel.get(c.trackId) || 'clip')
      e.classList.toggle('midi', c.kind === 'midi')
      e.classList.toggle('editing', c.id === editing)
      e.classList.toggle('sel', selection.includes(c.id))
      e.classList.toggle('unplayable', !canPlay)
      const o = outline.get(c.id)
      e.style.outline = o ? `2px solid ${o}` : ''
    }

    // collaborators' playheads
    for (const e of overlay.querySelectorAll('.remote-head')) e.remove()
    for (const r of st.remote) {
      if (r.playhead == null) continue
      overlay.append(h('div', { className: 'remote-head', style: `left:${HEADER + x(r.playhead)}px;background:${r.user.color}` }))
    }
    // The playhead lines run through the lanes and the master automation, not the empty space below them.
    const last = masterAuto.el.offsetHeight ? masterAuto.el : laneBox
    overlay.style.height = `${last.offsetTop + last.offsetHeight}px`
    // the lanes fill the scroller's height, so the space below the last track takes drops and selection boxes
    const fill = `${Math.max(0, view.h - el.offsetTop)}px`
    if (el.style.minHeight !== fill) el.style.minHeight = fill
    drawPlayhead()
    if (refreshPreviews()) ensurePreviewTick()
  }

  function makeClip(c: Clip) {
    const name = h('span', { className: 'clip-name' })
    name.addEventListener('dblclick', (ev) => { if (readOnly) return; ev.stopPropagation(); renameClip(c.id) })
    const head = h('div', { className: 'clip-head' }, name)
    const body = h('div', { className: 'clip-body' })
    const e = h('div', { className: 'clip', 'data-hint': readOnly ? 'click: show it in the dock' : 'click: edit in the dock · drag: move · drag the edges: trim · right edge, top: loop · alt: no snap · right-click: more' }, head, body)
    parts.set(c.id, { head, name, body })
    if (c.kind === 'audio') {
      const fade = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      fade.classList.add('fades')
      fade.innerHTML = '<path class="fade-area in"/><path class="fade-area out"/><path class="fade-line in"/><path class="fade-line out"/>'
      const handle = (which: 'in' | 'out') => {
        const hd = h('i', { className: `fade-h ${which}`, title: `fade ${which}: drag to set its length (double-click: change the curve)` })
        hd.addEventListener('pointerdown', (ev) => fadeDown(ev, c.id, which))
        hd.addEventListener('dblclick', (ev) => {
          ev.stopPropagation()
          const cur = clipsMap(doc).get(c.id)
          if (!cur || readOnly) return
          const shape = ((Number(cur.get('fadeShape')) || 0) + 1) % 3
          updateClip(doc, c.id, { fadeShape: shape as 0 | 1 | 2 })
          st.status(`fade curve: ${FADE_SHAPES[shape]}`)
        })
        return hd
      }
      const w: Wave = {
        cv: h('canvas', { className: 'wave' }), seams: h('i', { className: 'seams' }), first: h('i', { className: 'seam-first' }), label: name,
        notches: h('i', { className: 'notches' }), fade, fin: handle('in'), fout: handle('out'), sig: '', v0: 0, v1: 0,
      }
      waves.set(c.id, w)
      body.append(w.cv, w.seams, w.first, fade)
      head.append(w.notches)
      e.append(w.fin, w.fout)
    }
    e.onpointerdown = (ev) => clipDown(ev, c.id)
    e.ondblclick = () => st.openClip(c.id)
    e.onpointermove = (ev) => { // which handle is under the pointer drives the cursor and the edge highlight (CSS, by data-zone)
      if (ev.buttons) return
      const cur = clipsMap(doc).get(c.id)?.toJSON() as Clip | undefined
      const zone = cur && !readOnly && !lanes.get(cur.trackId)?.src && !st.locks.has(cur.trackId) ? clipZone(ev, e, cur) : 'move'
      if (e.dataset.zone !== zone) e.dataset.zone = zone
    }
    e.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      ev.stopPropagation() // not the lane's background menu underneath
      const trackId = String(clipsMap(doc).get(c.id)?.get('trackId'))
      if (!st.locks.has(trackId)) popover(e, clipMenu(c.id), [ev.clientX, ev.clientY])
    })
    clipEls.set(c.id, e)
    return e
  }

  /**
   * Waveforms are drawn for the on-screen part of the clip only (plus a viewport of margin each side),
   * at device-pixel resolution, so a 16-minute clip costs the same as a 10-second one.
   */
  function drawVisibleWave(
    c: Clip & { kind: 'audio' }, w: Wave, pk: Float32Array, width: number, height: number,
    /** The lane's frame: its scale, its horizontal scroller's width and scroll (read before the draw's writes), and how much of the scroller's left edge is covered. */
    f: { pps: number; viewW: number; scrollLeft: number; off: number },
  ) {
    const rt = rate()
    const dpr = window.devicePixelRatio || 1
    const viewW = f.viewW
    const left = f.off + (c.start / rt) * f.pps // clip's left edge in scroller-content px
    const need0 = Math.max(0, f.scrollLeft + f.off - left), need1 = Math.min(width, f.scrollLeft + viewW - left)
    if (need1 <= need0) { w.cv.style.display = 'none'; return }
    const pass = isLooping(c) ? c.loopLength! : 0
    const phase = pass ? c.loopPhase ?? 0 : 0
    const sig = `${f.pps}|${c.sourceOffset}|${c.length}|${pass}|${phase}|${width}|${height}|${dpr}`
    if (w.sig === sig && w.pk === pk && w.v0 <= need0 && w.v1 >= need1) { w.cv.style.display = ''; return }
    const v0 = Math.max(0, Math.floor(need0 - viewW)), v1 = Math.min(width, Math.ceil(need1 + viewW))
    Object.assign(w, { sig, pk, v0, v1 })
    w.cv.style.display = ''
    w.cv.style.left = `${v0}px`
    w.cv.style.width = `${v1 - v0}px`
    w.cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
    w.cv.height = Math.round(height * dpr)
    const fpp = rt / f.pps // source frames per css px
    const passPx = pass / fpp
    if (!pass || passPx < 2) return drawWave(w.cv, pk, c.sourceOffset + v0 * fpp, (v1 - v0) * fpp)
    // A looping clip draws the pass once per repeat: pass k covers clip px [k * passPx - phasePx, (k + 1) * passPx - phasePx),
    // the first (cut by the clip's start) from `phase` into the pass, the repeats faded. Each piece is drawn on a scratch
    // canvas (it must be in the document for drawWave to read the colour) and copied in.
    const phasePx = phase / fpp
    const g = w.cv.getContext('2d')!
    const tmp = h('canvas', { className: 'wave' })
    w.cv.after(tmp)
    g.clearRect(0, 0, w.cv.width, w.cv.height)
    for (let k = Math.max(0, Math.floor((v0 + phasePx) / passPx)); k * passPx - phasePx < v1; k++) {
      const s0 = Math.max(0, k * passPx - phasePx) // the piece in clip px, cut to the clip's start and to what the canvas holds
      const a = Math.max(s0, v0), b = Math.min((k + 1) * passPx - phasePx, v1)
      if (b - a < 1 / dpr) continue
      tmp.width = Math.max(1, Math.round((b - a) * dpr))
      tmp.height = w.cv.height
      drawWave(tmp, pk, c.sourceOffset + (a + phasePx - k * passPx) * fpp, (b - a) * fpp)
      g.globalAlpha = k ? 0.35 : 1
      g.drawImage(tmp, Math.round((a - v0) * dpr), 0)
    }
    g.globalAlpha = 1
    tmp.remove()
  }

  /** A looping audio clip's seams: a faint line where each pass ends, drawn as one repeating background from the first seam on. */
  function drawSeams(c: Clip & { kind: 'audio' }, w: Wave, width: number, cpps: number) {
    const rt = rate()
    const passPx = ((c.loopLength ?? 0) / rt) * cpps
    const first = (((c.loopLength ?? 0) - (c.loopPhase ?? 0)) / rt) * cpps
    const on = isLooping(c) && passPx >= 3 && first < width
    w.seams.style.display = on ? '' : 'none'
    w.notches.style.display = on ? '' : 'none'
    if (!on) return
    w.seams.style.left = `${first}px`
    w.seams.style.width = `${width - first}px`
    w.seams.style.backgroundSize = `${passPx}px 100%`
    w.notches.style.left = `${first - 4}px` // each tile carries the notch at its left edge, 4px in
    w.notches.style.width = `${width - first + 4}px`
    w.notches.style.backgroundSize = `${passPx}px 100%`
    w.first.style.left = `${first - 1}px`
  }

  /** An audio clip's fades: the faded-out corners shaded, each curve drawn by its shape, and a handle on each. */
  function drawFades(c: Clip & { kind: 'audio' }, w: Wave, width: number, height: number, cpps: number, editable: boolean) {
    const rt = rate()
    const fi = Math.min(width, (c.fadeIn / rt) * cpps)
    const fo = isForever(c) ? 0 : Math.min(width - fi, (c.fadeOut / rt) * cpps)
    const sig = `${fi.toFixed(1)}|${fo.toFixed(1)}|${width.toFixed(1)}|${height}|${c.fadeShape}`
    w.fin.hidden = !editable
    w.fout.hidden = !editable || isForever(c)
    w.fin.style.left = `${fi}px`
    w.fout.style.left = `${width - fo}px`
    w.fin.classList.toggle('set', fi > 0)
    w.fout.classList.toggle('set', fo > 0)
    if (w.fade.dataset.sig === sig) return
    w.fade.dataset.sig = sig
    w.fade.setAttribute('viewBox', `0 0 ${Math.max(1, width)} ${height}`)
    w.fade.setAttribute('width', String(Math.max(1, width)))
    w.fade.setAttribute('height', String(height))
    const curve = (from: number, len: number, rising: boolean) => {
      const n = Math.max(2, Math.min(48, Math.ceil(len / 3)))
      const pts: string[] = []
      for (let k = 0; k <= n; k++) {
        const t = k / n
        const g = fadeGain(rising ? t : 1 - t, c.fadeShape)
        pts.push(`${(from + t * len).toFixed(1)} ${(height * (1 - g)).toFixed(1)}`)
      }
      return pts
    }
    const [aIn, aOut, lIn, lOut] = [...w.fade.children] as SVGPathElement[]
    const pin = fi > 0.5 ? curve(0, fi, true) : null
    const pout = fo > 0.5 ? curve(width - fo, fo, false) : null
    aIn.setAttribute('d', pin ? `M0 0L${pin.join('L')}L${fi.toFixed(1)} 0Z` : '')
    lIn.setAttribute('d', pin ? `M${pin.join('L')}` : '')
    aOut.setAttribute('d', pout ? `M${(width - fo).toFixed(1)} 0L${pout.join('L')}L${width.toFixed(1)} 0Z` : '')
    lOut.setAttribute('d', pout ? `M${pout.join('L')}` : '')
  }

  /** Drag a fade handle: the fade's length follows the pointer (the two fades never overlap). One undo step. */
  function fadeDown(ev: PointerEvent, id: string, which: 'in' | 'out') {
    if (ev.button !== 0) return
    ev.stopPropagation()
    ev.preventDefault()
    const c = clipOf(id)
    if (!c || c.kind !== 'audio' || readOnly || st.locks.has(c.trackId)) return
    const cpps = lanes.get(c.trackId)?.src?.pps ?? st.ui.pps
    const rt = rate()
    const f0 = which === 'in' ? c.fadeIn : c.fadeOut
    st.select([id])
    undo.stopCapturing()
    dragPointer(ev, {
      onDrag: (m) => {
        const d = Math.round(((m.clientX - ev.clientX) / cpps) * rt) * (which === 'in' ? 1 : -1)
        const other = which === 'in' ? c.fadeOut : c.fadeIn
        const v = clamp(f0 + d, 0, Math.max(0, c.length - other))
        updateClip(doc, id, which === 'in' ? { fadeIn: v } : { fadeOut: v })
        st.status(`fade ${which} ${(v / rt * 1000).toFixed(0)} ms`)
      },
      onEnd: () => undo.stopCapturing(),
    })
  }
  const clipOf = (id: string) => clipsMap(doc).get(id)?.toJSON() as Clip | undefined

  /**
   * A MIDI clip's preview: its label plus tiny note marks, rebuilt only when the notes change. A looping clip draws its
   * first pass in full and the repeats faded. (The editors live in the dock.)
   */
  function drawMidiClip(pt: Parts, c: Clip & { kind: 'midi' }, notes: Note[], extent: number, label: string) {
    const lp = isLooping(c) ? c.loopTicks! : 0
    if (pt.name.textContent !== label) (pt.name.textContent = label), (pt.head.title = label)
    const key = `${notesVer}|${extent}|${lp}|${c.view ?? ''}`
    if (pt.midiKey === key) return // nothing it shows has changed
    pt.midiKey = key
    const sig = `${extent}|${lp}|${c.view ?? ''}|${notes.map((n) => `${n.tick},${n.durTicks},${n.pitch},${n.velocity}`).join(';')}`
    if (pt.body.dataset.sig === sig) return
    pt.body.dataset.sig = sig
    const shown = lp ? notes.filter((n) => n.tick < lp) : notes
    const lo = Math.min(...shown.map((n) => n.pitch)), hi = Math.max(...shown.map((n) => n.pitch))
    const passes = lp ? Math.ceil(extent / lp) : 1
    const marks: HTMLElement[] = []
    const notches: HTMLElement[] = []
    for (let k = 0; k < passes; k++) {
      if (k) { // where the pattern starts over
        const edge = h('i', { className: 'loop-edge' })
        edge.style.left = `${((k * lp) / extent) * 100}%`
        marks.push(edge)
        const notch = h('i', { className: 'notch' })
        notch.style.left = `${((k * lp) / extent) * 100}%`
        notches.push(notch)
        if (k === 1) { // the pass handle lights up here when hovered
          const first = h('i', { className: 'seam-first' })
          first.style.left = `calc(${(lp / extent) * 100}% - 1px)`
          marks.push(first)
        }
      }
      for (const n of shown) {
        const tick = k * lp + n.tick
        if (tick >= extent) continue
        const m = h('i', { className: k ? 'mark rep' : 'mark' })
        m.style.left = `${(tick / extent) * 100}%`
        m.style.width = `${(Math.min(n.durTicks, lp || Infinity) / extent) * 100}%` // (min-width in the CSS: a % minimum is huge on a forever clip)
        m.style.top = `${hi === lo ? 50 : 12 + ((hi - n.pitch) / (hi - lo)) * 72}%`
        m.style.setProperty('--v', String(Math.min(1, Math.max(0.2, n.velocity > 1 ? n.velocity / 127 : n.velocity))))
        marks.push(m)
      }
    }
    pt.body.replaceChildren(...marks)
    pt.head.replaceChildren(pt.name, ...notches)
  }

  /**
   * Where each looping clip's pass restarts (samples): one per repeat boundary inside the clip, so a clip
   * can be trimmed to land on the repeats (a `forever` clip's seams go on for ten minutes past its start).
   */
  function repeatSeams(clips: Clip[]): number[] {
    const rt = rate()
    const out: number[] = []
    for (const c of clips) {
      if (!isLooping(c)) continue
      const period = passLength(c, rt)
      const phase = c.kind === 'audio' ? c.loopPhase ?? 0 : 0
      const end = c.start + (isForever(c) ? Math.max(clipLength(c, rt), 600 * rt) : clipLength(c, rt))
      out.push(...passBoundaries(c.start, period, phase, end - 1))
    }
    return out
  }

  /**
   * Which handle of clip `c` (drawn as `el`) is under the pointer. The right edge loops (the whole height once the clip
   * loops, else its upper half; the lower half trims); a looping clip's first seam has the pass handle on its lower half.
   */
  function clipZone(ev: PointerEvent, el: HTMLElement, c: Clip): Grab {
    const box = el.getBoundingClientRect()
    const looping = isLooping(c)
    const cpps = lanes.get(c.trackId)?.src?.pps ?? st.ui.pps
    const seam = looping ? box.left + ((passLength(c, rate()) - (c.kind === 'audio' ? c.loopPhase ?? 0 : 0)) / rate()) * cpps : undefined
    return grabAt(ev.clientX, box, { y: ev.clientY, looping, seam })
  }

  // --- clip dragging (live Yjs updates, one undo step per drag)
  function clipDown(ev: PointerEvent, id: string) {
    if (ev.button !== 0) return
    const clip = getClips(doc).find((c) => c.id === id)
    if (!clip) return
    const rt = rate()
    const pps = st.ui.pps
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    const mode = clipZone(ev, ev.currentTarget as HTMLElement, clip)
    const lane0 = lanes.get(clip.trackId)
    const cpps = lane0?.src ? lane0.src.pps : pps // source clips scale with their own lane
    // a click (no drag) on a clip opens it in the dock's clip tab (D2)
    const clicked = () => { if (!(st.ui.dock.open && st.ui.dock.tab === 'clip' && st.ui.editing === id)) st.openClip(id) }
    st.setUi({ pad: null, note: null })
    // shift- or ⌘-click (ctrl elsewhere) adds the clip to the selection, or takes it out
    if (ev.shiftKey || (IS_MAC ? ev.metaKey : ev.ctrlKey)) {
      const sel = st.ui.selection
      st.select(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id], false)
      return
    }
    // grabbing a clip of a selection moves all of it (the clips of locked tracks and source lanes stay)
    const sel0 = st.ui.selection
    const group = mode === 'move' && sel0.length > 1 && sel0.includes(id)
      ? sel0.filter((x) => { const c = clipOf(x); return !!c && !lanes.get(c.trackId)?.src && !st.locks.has(c.trackId) })
      : null
    if (!group) st.select([id], false) // (opened in the dock on release, if it was a click)
    if (readOnly || lane0?.src || st.locks.has(clip.trackId)) return clicked() // source audio stays anchored: only the loop windows move
    undo.stopCapturing()
    ev.preventDefault()
    // alt-drag leaves a copy behind (then alt doesn't mean "no snap"; ctrl / ⌘ still does)
    const copy = mode === 'move' && ev.altKey
    let copied = false
    const mods = (m: PointerEvent) => ({ altKey: copy ? false : m.altKey, ctrlKey: m.ctrlKey || m.metaKey })
    const moving = new Set(group ?? [id])
    const from = new Map([...moving].map((x) => { const c = clipOf(x)!; return [x, { start: c.start, trackId: c.trackId }] as const }))
    const index = new Map(getTracks(doc).map((t, i) => [t.id, i]))
    const grab = ev.clientX - box.left // where in the clip it was picked up
    let curTrack = clip.trackId
    const srcFrames = sourceFrames(doc, clip, rt)
    const notes0 = clip.kind === 'midi' ? getNotes(doc).filter((n) => n.clipId === id) : []
    // snap targets: the timeline start, the playhead and the edges of every other clip and pad (source lanes keep their own time)
    const clips = getClips(doc).filter((c) => !moving.has(c.id) && !lanes.get(c.trackId)?.src)
    const length = clipLength(clip, rt)
    // a `forever` clip's real extent is off screen: the loop handle at its drawn end sets the extent from there
    const drawn = isForever(clip) ? (box.width / cpps) * rt : length
    const pass0 = passLength(clip, rt)
    const phase0 = clip.kind === 'audio' && isLooping(clip) ? clip.loopPhase ?? 0 : 0
    const seam0 = clip.start + pass0 - phase0
    const snapAt = snapTracker([
      0,
      Math.round(position()),
      ...clips.flatMap((c) => [c.start, c.start + clipLength(c, rt)]),
      ...getPads(doc).flatMap((p) => [p.start, p.start + p.length]),
      ...repeatSeams(clips),
      ...(mode === 'loop' ? passBoundaries(clip.start, pass0, phase0, clip.start + drawn + 600 * rt) : []), // whole passes of this clip
    ], (REARM_PX / pps) * rt)
    const showSnap = (at: number | null) => {
      snapLine.hidden = at == null
      if (at != null) snapLine.style.left = `${HEADER + x(at)}px`
    }
    const snapTo = (m: PointerEvent, at: number, d: number) => { // soft-snap the handle at sample `at` (moved `d`), with the snap line
      const snap = m.altKey || m.ctrlKey || m.metaKey ? null : snapAt(at + d, 0, (SNAP_PX / pps) * rt)
      showSnap(snap ? snap.at : null)
      return snap ? snap.at - at : d
    }
    dragPointer(ev, {
      onDrag: (m) => {
        if (!clipsMap(doc).has(id)) return
        if (mode === 'loop') return loopClip(doc, rt, clip, drawn + snapTo(m, clip.start + drawn, Math.round(((m.clientX - ev.clientX) / cpps) * rt)), srcFrames)
        if (mode === 'pass') {
          const d = Math.round(((m.clientX - ev.clientX) / cpps) * rt)
          return passClip(doc, rt, clip, pass0 + (clip.kind === 'audio' ? snapTo(m, seam0, d) : d), srcFrames)
        }
        if (mode !== 'move') {
          let d = Math.round(((m.clientX - ev.clientX) / cpps) * rt)
          // an audio clip's edge snaps to the same targets, repeat seams included, so it can be trimmed to land on them
          // every edge lands on the grid otherwise (alt / ctrl: free)
          const edge = mode === 'l' ? clip.start + d : clip.start + length + d
          const free = m.altKey || m.ctrlKey || m.metaKey
          const snap = clip.kind !== 'audio' || free ? null : snapAt(edge, 0, (SNAP_PX / pps) * rt)
          if (snap) d += snap.at - edge
          else if (!free) d += st.snap(edge, m) - edge
          showSnap(snap ? snap.at : null)
          return trimClip(doc, rt, clip, mode, d, srcFrames, notes0)
        }
        // Absolute position under the pointer, in the target lane's own scale (source lanes differ).
        const hit = targetAt(m.clientY, clip.kind)
        if (hit && !(group && lanes.get(hit)?.src)) curTrack = hit // (a group stays on the main timeline)
        const host = hostOf(curTrack)
        let start = Math.max(0, Math.round(((m.clientX - grab - host.el.getBoundingClientRect().left) / host.pps) * rt))
        const md = mods(m)
        const free = md.altKey || md.ctrlKey || !!lanes.get(curTrack)?.src
        // an edge within reach wins; otherwise the start lands on the grid
        const snap = free ? null : snapAt(start, length, (SNAP_PX / host.pps) * rt)
        if (snap) start = snap.start
        else if (!free) start = st.snap(start, md)
        showSnap(snap ? snap.at : null)
        if (copy && !copied) { // the copies stay where the clips were; the clips themselves move on
          copied = true
          const data = copyClips(doc, [...moving])
          if (data) pasteClips(doc, data, { at: data.origin })
        }
        if (group) moveGroup(doc, from, start - clip.start, (index.get(curTrack) ?? 0) - (index.get(clip.trackId) ?? 0))
        else updateClip(doc, id, { start, ...(curTrack !== clip.trackId ? { trackId: curTrack } : {}) })
      },
      onEnd: (moved) => {
        showSnap(null)
        undo.stopCapturing()
        if (moved) return
        if (group) st.select([id]) // a click on one clip of a selection selects just that one
        clicked()
      },
    })
  }

  /**
   * The track a dragged clip would land on: audio clips go to audio lanes or to any soundscape's source
   * lane; MIDI clips to MIDI lanes. Null when the pointer isn't over a valid lane.
   */
  function targetAt(clientY: number, clipKind: string): string | null {
    const within = (e: HTMLElement) => {
      const r = e.getBoundingClientRect()
      return clientY >= r.top && clientY < r.bottom
    }
    for (const [id, l] of lanes) {
      if (clipKind === 'audio' && l.src && within(l.src.row)) return id
      if (within(l.row) && accepts(String(tracksMap(doc).get(id)?.get('kind')), clipKind)) return id
    }
    return null
  }
  const hostOf = (trackId: string) => {
    const l = lanes.get(trackId)
    return l?.src ? { el: l.src.body, pps: l.src.pps } : { el: l?.body ?? el, pps: st.ui.pps }
  }

  // --- incoming takes (docs/engine.md §9.3)
  /** Whether this device still has the audio of an incoming take of ours (assumed while the check runs). */
  function stagedHere(hash: string) {
    if (!staged.has(hash)) {
      staged.set(hash, true)
      void hasStaged(s.projectId, hash).then((v) => v === staged.get(hash) || (staged.set(hash, v), schedule()))
    }
    return staged.get(hash)!
  }
  function incomingLabel(m: SampleMeta) {
    const mine = isMine(st.takeCtx(), m)
    if (mine && stagedHere(m.hash)) return 'local only · click for options'
    return `incoming from ${m.byName ?? 'someone'}${mine ? ', not on this device' : ''}`
  }
  const failed = (err: unknown) => st.status((err as Error).message)
  /** Rename a clip in place: its name strip becomes a text field (empty: back to the default label). */
  function renameClip(clipId: string) {
    const pt = parts.get(clipId)
    if (!pt || readOnly) return
    const cur = clipOf(clipId)
    const input = h('input', { className: 'clip-rename', value: cur?.name ?? pt.name.textContent ?? '', 'aria-label': 'clip name' })
    let finished = false
    const done = (ok: boolean) => {
      if (finished) return
      finished = true
      if (ok && clipsMap(doc).has(clipId)) {
        const v = input.value.trim()
        undo.stopCapturing()
        if (v) updateClip(doc, clipId, { name: v })
        else clipsMap(doc).get(clipId)?.delete('name')
        undo.stopCapturing()
      }
      input.replaceWith(pt.name)
      pt.name.textContent = '' // (redrawn with the new label)
      draw()
    }
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) }
    input.onblur = () => done(true)
    for (const t of ['pointerdown', 'click', 'dblclick'] as const) input.addEventListener(t, (e) => e.stopPropagation())
    pt.name.replaceWith(input)
    input.focus()
    input.select()
  }

  /** The clip's right-click menu (P3-15): open, split, duplicate, copy, cut, rename, looping, delete. */
  function clipMenu(clipId: string): MenuItem[] {
    const clip = clipOf(clipId)
    const mod = IS_MAC ? '⌘' : 'ctrl+'
    const kindIcon = clip?.kind === 'audio' ? 'wave' : clip?.kind === 'midi' && clip.view === 'drums' ? 'drum' : 'piano'
    const open: MenuItem = { label: 'open in the dock', icon: kindIcon, hint: 'click', run: () => st.openClip(clipId) }
    if (readOnly || !clip) return [open]
    // the whole selection when this clip is in it
    const targets = () => { const sel = st.ui.selection; return sel.includes(clipId) ? [...sel] : [clipId] }
    const step = (f: () => void) => { undo.stopCapturing(); f(); undo.stopCapturing() }
    const at = Math.round(position())
    const onSource = !!lanes.get(clip.trackId)?.src
    const inside = !onSource && at > clip.start && at < clip.start + clipLength(clip, rate())
    const items: MenuItem[] = [
      open,
      'sep',
      { label: 'split at the playhead', icon: 'scissors', hint: 'S', disabled: !inside,
        title: inside ? undefined : 'move the playhead into the clip to split it there', run: () => step(() => { splitClip(doc, clipId, at) }) },
      { label: 'duplicate', icon: 'duplicate', hint: `${mod}D`, run: () => {
        let ids: string[] = []
        step(() => { ids = duplicateClips(doc, targets(), rate()) })
        if (ids.length) st.select(ids, ids.length === 1)
      } },
      { label: 'copy', icon: 'duplicate', hint: `${mod}C`, run: () => { const d = copyClips(doc, targets()); clipboard.set(d); if (d) st.status(`Copied ${d.items.length} clip${d.items.length === 1 ? '' : 's'}.`) } },
      { label: 'cut', icon: 'scissors', hint: `${mod}X`, run: () => {
        let d: ReturnType<typeof cutClips> = null
        step(() => { d = cutClips(doc, targets()) })
        clipboard.set(d)
        st.select([])
      } },
      { label: 'rename', icon: 'edit', hint: 'double-click the name', run: () => renameClip(clipId) },
      'sep',
    ]
    if (!onSource) {
      if (!isForever(clip)) items.push({ label: 'loop forever', icon: 'loop',
        title: 'repeat the clip (its pattern, or its audio) for as long as the song plays; drag the right edge to stop it somewhere instead',
        run: () => step(() => setLoopOn(doc, rate(), clip, true)) })
      else items.push({ label: 'loop to the end of the clip only', icon: 'loop', title: 'stop repeating past the clip\'s right edge', run: () => step(() => setLoopOn(doc, rate(), clip, false)) })
      if (isLooping(clip)) items.push({ label: 'no loop', icon: 'close', title: 'play the pattern once', run: () => step(() => setLoopOff(doc, clip)) })
      items.push('sep')
    }
    items.push({ label: 'delete', icon: 'trash', danger: true, hint: '⌫', run: () => {
      step(() => doc.transact(() => targets().forEach((id) => deleteClip(doc, id))))
      st.select([])
    } })
    const hash = String(clipsMap(doc).get(clipId)?.get('sourceHash'))
    const meta = getSamples(doc)[hash]
    if (meta?.status !== 'incoming') return items
    items.length = 0 // an incoming take is saved or discarded, not just its clip deleted
    const ctx = st.takeCtx()
    if (isMine(ctx, meta)) {
      items.push(['save', () => {
        st.status('uploading take…')
        uploadTake(ctx, hash).then(() => st.status(''), failed)
      }])
      if (myTakes(ctx).length > 1) items.push(['save all', () => {
        st.status('uploading takes…')
        uploadAll(ctx).then((r) => st.status(r.gone ? `${r.up} uploaded, ${r.gone} not on this device` : ''), failed)
      }])
    }
    items.push(['discard', () => {
      if (!confirm(`discard "${meta.name}" and every clip that plays it?`)) return
      discardTake(ctx, hash)
      st.select([])
    }])
    return items
  }

  // --- events
  scroll.addEventListener('scroll', schedule, { passive: true })
  addEventListener('resize', schedule)
  const LANE_UI: (keyof typeof st.ui)[] = ['pps', 'selection', 'editing', 'focusTrack', 'pad', 'looperArm', 'autoOpen', 'narrow']
  setNarrowHeader(st.ui.narrow)
  const offs = [
    st.on('doc', draw),
    st.on('ui', (p) => { if (LANE_UI.some((k) => k in p)) draw() }),
    heights.on(schedule),
    st.on('tick', (p) => drawPlayhead(p)),
    st.on('transport', () => { drawPlayhead(); ensurePreviewTick() }),
  ]
  const offKeys = registerArrangeKeys(st)
  acceptDrops(master.firstElementChild as HTMLElement, MASTER_TRACK, masterBody) // effects onto the master
  draw()

  return {
    el,
    destroy() {
      destroyed = true
      offKeys()
      removeEventListener('dragstart', onDragStart)
      removeEventListener('dragend', onDragEnd)
      removeEventListener('drop', onDragEnd)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(previewRaf)
      scroll.removeEventListener('scroll', schedule)
      removeEventListener('resize', schedule)
      offs.forEach((f) => f())
      notesMap(doc).unobserveDeep(onNotes)
    },
  }
}
