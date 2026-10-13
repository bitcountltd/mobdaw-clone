// The top bar (docs/redesign.md §2, §3):
//   left    wordmark (all projects), project name (settings), saved state
//   centre  transport (rewind, play, record, loop, metronome, count-in, pedal), the display (the counter: bar.beat.16th
//           lit, the clock dim, click to swap; tempo with drag / type / tap; meter), snap
//   right   undo / redo, arrange / mix, browser / dock, the master scope, cpu, export, help; presence and chat (cloud)
// Narrow windows fold the secondary groups into a "more" panel (≤ 900px), down to transport + counter on a phone.
// It also owns the grid and view shortcuts: L loop, T tap tempo, Z zoom to fit, X arrange / mix, ⌘+ / ⌘- zoom.
import {
  BPM_MAX, BPM_MIN, GRID_SIZES, addClickTrack, barsBeats, clipsMap, fitClickTrack, getLoop, getLoopers, getPoints, getTracks,
  metaMap, setBeatsPerBar, setProjectTempo, tapBpm, tracksMap, updateTrack, type GridSize, type Role,
} from '@mobdaw/shared'
import { getCtx } from '../audio/context'
import { renderProject } from '../audio/render'
import { CLOUD } from '../cloud'
import { h } from '../dom'
import { homeLink } from '../router'
import { iconButton, numberField, segmented, toggle, tooltip } from '../theme/controls'
import { icon } from '../theme/icons'
import type { chatPanel } from '../ui/chat'
import { exportDialog } from '../ui/exportDialog'
import { popoverPanel } from '../ui/popover'
import { projectMenu } from '../ui/projectMenu'
import { fmt } from '../ui/transport'
import { ZOOM_FIT, ZOOM_MAX, ZOOM_MIN } from './arrange/arrange'
import { toggleLoop } from './arrange/ruler'
import { registerKeys } from './keys'
import { mountSectionLabel } from './markers'
import { qwertyOf, QWERTY_KEYS } from './qwerty'
import { mountScope } from './scope'
import type { Studio } from './studio'
import './topbar.css'

export type Cloud = { projectId: string; me: string; role: Role; owner: boolean; locked: boolean; public: boolean; admin: boolean; demo: boolean }
export type TopbarOpts = {
  projectName: string
  renameProject?: (name: string) => Promise<unknown> | void
  cloud?: Cloud
  /** The chat panel the toggle shows and hides (absent for projects on this device). */
  chat?: ReturnType<typeof chatPanel>
}

export const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = MAC ? '⌘' : 'ctrl+'
/** The shortcuts this module handles, for the ? overlay. */

const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const FIGURE = ' ' // a digit-wide space, for the counter's fixed width
const COUNTER_KEY = 'mobdaw.counter'
/** "bar 5" or "bars 5 to 8" (both inclusive). */
const loopBars = (a: number, b: number) => (a >= b ? `bar ${a}` : `bars ${a} to ${b}`)
const gridLabel = (g: GridSize) => GRID_SIZES.find((s) => s.value === g)?.label ?? '1/16'

/** True when a key press belongs to a text field (or a control that takes keys), not to the studio. */
export const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement
  const tag = t?.tagName
  return tag === 'SELECT' || tag === 'TEXTAREA' || !!t?.isContentEditable || (tag === 'INPUT' && (t as HTMLInputElement).type !== 'range')
}

export function mountTopbar(st: Studio, opts: TopbarOpts) {
  const { s, doc, readOnly, undo } = st
  let projectName = opts.projectName
  const { cloud, chat } = opts
  if (import.meta.env.DEV) (window as unknown as { __studio?: Studio }).__studio = st // (for the screenshot scripts)

  // ---------------------------------------------------------------- left: wordmark, project, saved
  /** Nothing is placed on a timeline yet (positions are in samples, so only then can the rate change). */
  const isBlank = () => !getTracks(doc).length && !getPoints(doc).length && !getLoopers(doc).length
  const titleText = h('span', { className: 'pn-text' }, projectName)
  /** The project's name: a button that opens the project settings (rename, sharing, audio input, pedal). */
  const title: HTMLButtonElement = h('button', { className: 'project-name', type: 'button', title: 'project settings', onclick: () => openProject() },
    titleText, icon('chevron-down', 14, 'pn-chev'))
  function openProject(anchor: HTMLElement = title) {
    projectMenu(anchor, {
      name: projectName,
      rename: opts.renameProject,
      onRenamed: (n) => (titleText.textContent = projectName = n),
      cloud: cloud && { ...cloud, onPublic: (v) => (cloud.public = v), onDemo: (v) => (cloud.demo = v) },
      sampleRate: {
        value: st.rate,
        locked: readOnly ? 'readonly' : isBlank() ? null : 'tracks',
        set: (r) => isBlank() && metaMap(doc).set('sampleRate', r),
      },
      onInputChanged: () => void st.rec.reopenInput(),
      onPedalChanged: readOnly ? undefined : () => st.pedal.settingsChanged(),
      snapshots: s.local ? { project: s.projectId, doc } : undefined, // version history (pages/snapshots.ts)
    })
  }
  const savedText = h('span', { className: 'saved-text' }, 'saved')
  const saved = h('span', { className: 'saved', 'data-state': 'saved', 'data-hint': s.local ? 'every change is saved in this browser, on this device' : 'every change is saved to the server' },
    h('i', { className: 'saved-dot' }), savedText)
  const left = h('div', { className: 'tb-l' },
    h('a', { ...homeLink, className: 'logo', title: 'all projects' }, 'mobdaw'), title,
    readOnly ? h('span', { className: 'tb-ro dim' }, 'view only') : saved)

  // ---------------------------------------------------------------- centre: transport
  const rewind = iconButton('rewind', 'go to the start', () => st.rewind(), 'tb-rewind')
  tooltip(rewind, 'go to the start', 'home')
  const play = iconButton('play', 'play / stop', () => st.toggle(), 'tb-play')
  tooltip(play, 'play / stop', 'space')
  const rec = toggle({ icon: 'record' }, { tone: 'rec', className: 'tb-rec', onChange: () => { rec.set(!!st.rec.take || st.midi.active); void st.toggleRecord() } })
  tooltip(rec.el, 'record onto the armed track, or a new one · right-click: input offset', 'shift+space')
  rec.el.addEventListener('contextmenu', (e) => { e.preventDefault(); st.rec.offsetMenu(e) })
  const loopBtn = toggle({ icon: 'loop' }, { className: 'tb-loop', onChange: () => toggleLoop(st) })
  tooltip(loopBtn.el, 'loop the cycle region', 'L')
  // The metronome is an ordinary MIDI track (role 'click'): the button makes it, and then mutes / unmutes it.
  const metro = toggle({ icon: 'metronome' }, { className: 'tb-metro', onChange: () => toggleClick() })
  tooltip(metro.el, 'metronome (adds a click track, then mutes / unmutes it)')
  function toggleClick() {
    const t = getTracks(doc).find((x) => x.role === 'click')
    // switching it off closes its clip in the editor
    if (t && !t.muted && st.ui.editing && clipsMap(doc).get(st.ui.editing)?.get('trackId') === t.id) st.openClip(null)
    if (t) updateTrack(doc, t.id, { muted: !t.muted })
    else doc.transact(() => { addClickTrack(doc); fitClickTrack(doc) })
  }
  let countInOn = false
  try { countInOn = localStorage.getItem('mobdaw.countIn') === '1' } catch { /* (not remembered) */ }
  const countBtn = toggle('count-in', { className: 'tb-count', on: countInOn, onChange: (on) => {
    countInOn = on
    try { localStorage.setItem('mobdaw.countIn', on ? '1' : '0') } catch { /* (not remembered) */ }
  } })
  tooltip(countBtn.el, 'count-in: one bar of click before recording starts')
  // The computer keyboard instrument (⇧K): lit while the letter keys play notes, with the octave they start at.
  const keysLabel = h('span', { className: 'tb-keys-oct num' })
  const keysBtn = toggle(h('span', { className: 'tb-keys-in' }, icon('keyboard', 16), h('span', { className: 'tb-keys-txt' }, 'keys'), keysLabel), {
    className: 'tb-keys', onChange: () => { qwertyOf(st)?.toggle(); drawKeys() },
  })
  function drawKeys() {
    const q = qwertyOf(st)
    keysBtn.set(!!q?.on)
    keysLabel.textContent = q ? q.range().split('–')[0] : ''
    tooltip(keysBtn.el, q?.on ? `computer keyboard on: A – ' play ${q.range()} · Z / X octave` : 'play the focused instrument from the computer keyboard', '⇧K')
  }
  const pedalBtn = toggle('pedal', { className: 'tb-pedal', onChange: () => { pedalBtn.set(st.pedal.on); void st.pedal.set(!st.pedal.on) } })
  const transport = h('div', { className: 'tb-transport' }, rewind, play, readOnly ? null : rec.el, loopBtn.el, metro.el, readOnly ? null : countBtn.el, keysBtn.el, readOnly ? null : pedalBtn.el)
  for (const b of [loopBtn.el, metro.el]) b.disabled = readOnly

  // ---------------------------------------------------------------- centre: the display (counter, tempo, meter)
  let clockFirst = false
  try { clockFirst = localStorage.getItem(COUNTER_KEY) === 'clock' } catch { /* (not remembered) */ }
  const cMain = h('span', { className: 'c-main' })
  const cSub = h('span', { className: 'c-sub' })
  const counter = h('button', { className: 'counter', type: 'button', 'aria-live': 'off', 'data-hint': 'position: bar.beat.sixteenth and the clock · click to swap which is big' }, cMain, cSub)
  tooltip(counter, 'click: swap bars and clock')
  counter.onclick = () => {
    clockFirst = !clockFirst
    try { localStorage.setItem(COUNTER_KEY, clockFirst ? 'clock' : 'bars') } catch { /* (not remembered) */ }
    drawCounter(st.position(), true)
  }
  let lastBars = '', lastClock = ''
  function drawCounter(p: number, force = false) {
    if (counting) return
    const b = barsBeats(Math.max(0, p), st.tempo(), st.rate)
    const bars = `${String(b.bar).padStart(3, FIGURE)}.${b.beat}.${b.sixteenth}`
    const clock = fmt(Math.max(0, p) / st.rate)
    if (!force && bars === lastBars && clock === lastClock) return
    lastBars = bars
    lastClock = clock
    counter.classList.toggle('clock-first', clockFirst)
    cMain.textContent = clockFirst ? clock : bars
    cSub.textContent = clockFirst ? bars.replaceAll(FIGURE, '') : clock
  }

  const bpm = numberField({
    value: st.tempo().bpm, min: BPM_MIN, max: BPM_MAX, step: 1, title: 'tempo: drag to change, click to type',
    onInput: (v) => setBpmSoon(v), onChange: (v) => (setBpmSoon(v), endTempo()),
  })
  bpm.el.classList.add('tb-bpm')
  bpm.el.disabled = readOnly
  bpm.el.dataset.hint = 'tempo (bpm): drag sideways or up / down, click to type · clips stay on their bars'
  let bpmRaf = 0, bpmWant = 0
  // a drag scales everything from where it was when the drag began (no drift), as one undo step (Studio.beginTempoChange)
  let tempoCh: ReturnType<Studio['beginTempoChange']> | null = null, tempoIdle = 0
  function setBpmSoon(v: number) {
    if (readOnly) return
    bpmWant = v
    tempoCh ??= st.beginTempoChange()
    clearTimeout(tempoIdle)
    tempoIdle = window.setTimeout(endTempo, 1500) // (a drag that ends where it began reports no change)
    if (!bpmRaf) bpmRaf = requestAnimationFrame(() => { bpmRaf = 0; tempoCh?.set(bpmWant) })
  }
  function endTempo() {
    clearTimeout(tempoIdle)
    if (bpmRaf) (cancelAnimationFrame(bpmRaf), (bpmRaf = 0), tempoCh?.set(bpmWant))
    tempoCh?.end()
    tempoCh = null
  }
  let taps: number[] = []
  const tapBtn = h('button', { className: 'tb-tap', type: 'button', disabled: readOnly, onclick: (e: MouseEvent) => tap(e.timeStamp) }, 'tap')
  tooltip(tapBtn, 'tap the tempo', 'T')
  function tap(now: number) {
    if (readOnly) return
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = []
    taps.push(now)
    tapBtn.classList.add('hit')
    setTimeout(() => tapBtn.classList.remove('hit'), 90)
    const v = taps.length >= 3 ? tapBpm(taps) : null
    if (v != null) {
      setProjectTempo(doc, Math.round(v))
      st.status(`tempo ${Math.round(v)} bpm (tapped)`)
    } else st.status(taps.length === 1 ? 'tap tempo: keep tapping…' : 'tap tempo: once more…')
  }
  const meterBtn = h('button', { className: 'tb-meter', type: 'button', disabled: readOnly, 'data-hint': 'meter: beats per bar' })
  tooltip(meterBtn, 'meter (beats per bar)')
  meterBtn.onclick = () => meterPanel(meterBtn)
  function meterPanel(anchor: HTMLElement) {
    const seg = segmented(['2', '3', '4', '5', '6', '7'].map((v) => ({ value: v, label: `${v}/4` })), String(st.tempo().beatsPerBar), (v) => {
      setBeatsPerBar(doc, Number(v))
      close()
    })
    const close = popoverPanel(anchor, h('div', { className: 'tb-pop' }, h('div', { className: 'tb-pop-label' }, 'Beats per bar'), seg.el))
  }
  const section = mountSectionLabel(st) // the song section the playhead is in (markers)
  const display = h('div', { className: 'tb-display' },
    counter,
    section.el,
    h('span', { className: 'tb-sep' }),
    h('span', { className: 'tb-tempo' }, bpm.el, h('span', { className: 'tb-unit' }, 'bpm'), tapBtn),
    meterBtn)

  // ---------------------------------------------------------------- centre: snap
  let lastGrid: GridSize = st.ui.grid || 0.25
  const snapBtn = toggle({ icon: 'magnet' }, { className: 'tb-magnet', on: !!st.ui.grid, onChange: () => {
    if (st.ui.grid) (lastGrid = st.ui.grid), st.setUi({ grid: 0 })
    else st.setUi({ grid: lastGrid || 0.25 })
  } })
  const snapToggle = snapBtn.el
  tooltip(snapToggle, 'snap to grid on / off (hold alt while dragging: free)')
  const snapSize = h('button', { className: 'tb-snapsize', type: 'button' }, h('span', {}), icon('chevron-down', 12))
  tooltip(snapSize, 'grid size')
  snapSize.onclick = () => gridPanel(snapSize)
  function gridPanel(anchor: HTMLElement) {
    const seg = segmented(GRID_SIZES.map((g) => ({ value: String(g.value), label: g.label })), String(st.ui.grid), (v) => {
      st.setUi({ grid: (v === 'bar' ? 'bar' : Number(v)) as GridSize })
      close()
    })
    const close = popoverPanel(anchor, h('div', { className: 'tb-pop' }, h('div', { className: 'tb-pop-label' }, 'Snap to'), seg.el))
  }
  const snap = h('div', { className: 'tb-snap', 'data-hint': 'snap: where clips, notes and the loop land when dragged' }, snapToggle, snapSize)

  const centre = h('div', { className: 'tb-c' }, transport, display, snap)

  // ---------------------------------------------------------------- right
  const undoBtn = iconButton('undo', 'undo', () => undo.undo(), 'tb-undo')
  tooltip(undoBtn, 'undo', `${MOD}Z`)
  const redoBtn = iconButton('redo', 'redo', () => undo.redo(), 'tb-redo')
  tooltip(redoBtn, 'redo', MAC ? '⇧⌘Z' : 'ctrl+shift+Z')
  const view = segmented<'arrange' | 'mix'>([
    { value: 'arrange', icon: 'arrange', label: h('span', { className: 'tb-view-txt' }, 'arrange'), title: 'arrange (X)' },
    { value: 'mix', icon: 'mixer', label: h('span', { className: 'tb-view-txt' }, 'mix'), title: 'mix (X)' },
  ], st.ui.view, (v) => st.setUi({ view: v }))
  view.el.classList.add('tb-view')
  for (const b of view.el.querySelectorAll('button')) tooltip(b, b.title.replace(' (X)', ''), 'X')
  const browserBtn = toggle({ icon: 'browser' }, { on: st.ui.browserOpen, onChange: (on) => st.setUi({ browserOpen: on }) })
  tooltip(browserBtn.el, 'browser', 'B')
  const dockBtn = toggle({ icon: 'dock' }, { on: st.ui.dock.open, onChange: (on) => st.setUi({ dock: { ...st.ui.dock, open: on } }) })
  tooltip(dockBtn.el, 'editor dock', 'D')
  const scope = mountScope(st)
  const cpu = h('span', { className: 'tb-cpu', 'data-hint': 'audio engine load: share of the real-time budget used by DSP' }, 'cpu –')
  const doExport = () => {
    if (!st.pb) return // (the project has not synced yet)
    const l = getLoop(doc)
    const bar = (smp: number) => barsBeats(smp, st.tempo(), st.rate)
    const loop = l && l.end > l.start ? { start: l.start, end: l.end, label: `${loopBars(bar(l.start).bar, bar(l.end - 1).bar)}${l.on ? '' : ' (the loop is off)'}` } : null
    exportDialog({ name: projectName, loop, render: (o) => renderProject(doc, s.projectId, st.rate, s.userId, o) })
  }
  const exportBtn = iconButton('export', 'export', doExport, 'tb-export')
  tooltip(exportBtn, 'export the song to an audio file')
  const help = () => window.dispatchEvent(new CustomEvent('mobdaw:help'))
  const helpBtn = iconButton('help', 'shortcuts and help', help, 'tb-help')
  tooltip(helpBtn, 'shortcuts and help', '?')
  const pedalText = h('span', { className: 'pedal-st', title: 'loop pedal: the number of loops going; red while a layer is recording' })
  const showCloud = CLOUD && !s.local
  const presence = showCloud ? h('span', { className: 'presence' }) : null
  const chatBtn = showCloud && chat ? h('button', { className: 'chat-btn', type: 'button', onclick: () => {
    chat.setOpen(!chat.open)
    chatBtn!.classList.toggle('on', chat.open)
    window.dispatchEvent(new Event('resize')) // the arrangement's width changed
  } }, icon('chat'), h('span', { className: 'chat-n' })) : null
  if (chatBtn) tooltip(chatBtn, 'chat')
  const moreBtn = iconButton('more', 'more', () => morePanel(), 'tb-more')
  tooltip(moreBtn, 'more controls')

  const right = h('div', { className: 'tb-r' },
    pedalText,
    h('div', { className: 'tb-grp tb-hist' }, undoBtn, redoBtn),
    view.el,
    h('div', { className: 'tb-grp tb-panels' }, browserBtn.el, dockBtn.el),
    h('div', { className: 'tb-meterbox' }, scope.el, cpu),
    h('div', { className: 'tb-grp tb-files' }, exportBtn, helpBtn),
    presence, chatBtn, moreBtn)

  /** Says "recording" / "stopped" to screen readers (the counter itself is not live: it changes every frame). */
  const live = h('span', { className: 'sr-only', role: 'status', 'aria-live': 'polite' })
  const el = h('header', { className: 'studio-top tb' }, left, centre, right, live)

  /** What the bar has folded away at this width lives here (and only that, plus the things that never fit the bar). */
  function morePanel() {
    /** The bar shows `el` now (so the panel leaves it out). */
    const shown = (...els: (Element | null)[]) => els.every((x) => !!x && x.getClientRects().length > 0)
    const row = (label: string, ...kids: (Node | null)[]) => h('div', { className: 'mp-row' }, h('span', { className: 'mp-label' }, label), ...kids)
    const act = (ic: Parameters<typeof icon>[0], label: string, run: () => void, hint?: string, disabled = false, on?: boolean) =>
      h('button', { className: 'mp-act', type: 'button', disabled, 'aria-pressed': on == null ? undefined : String(on), onclick: () => { close(); run() } },
        icon(ic), h('span', {}, label), on == null ? h('span', {}) : h('span', { className: `mp-state${on ? ' on' : ''}` }, on ? 'on' : 'off'), h('span', { className: 'kbd-hint' }, hint ?? ''))
    const q = qwertyOf(st)
    const tempo = numberField({ value: st.tempo().bpm, min: BPM_MIN, max: BPM_MAX, step: 1, onChange: (v) => !readOnly && setProjectTempo(doc, v) })
    const meter = segmented(['2', '3', '4', '5', '6', '7'], String(st.tempo().beatsPerBar), (v) => !readOnly && setBeatsPerBar(doc, Number(v)))
    const grid = segmented(GRID_SIZES.map((g) => ({ value: String(g.value), label: g.label })), String(st.ui.grid), (v) => st.setUi({ grid: (v === 'bar' ? 'bar' : Number(v)) as GridSize }))
    const viewSeg = segmented<'arrange' | 'mix'>(['arrange', 'mix'], st.ui.view, (v) => st.setUi({ view: v }))
    const rows = [
      shown(bpm.el, tapBtn) ? null : row('Tempo', tempo.el, h('span', { className: 'dim' }, 'bpm'), h('button', { className: 'tb-tap', type: 'button', disabled: readOnly, onclick: (e: MouseEvent) => { tap(e.timeStamp); tempo.set(st.tempo().bpm) } }, 'tap')),
      shown(meterBtn) ? null : row('Beats per bar', meter.el),
      shown(snapSize) ? null : row('Snap', grid.el),
      shown(view.el) ? null : row('View', viewSeg.el),
    ].filter(Boolean)
    const acts = [
      shown(undoBtn) ? null : act('undo', 'undo', () => undo.undo(), `${MOD}Z`, readOnly || !undo.undoStack.length),
      shown(redoBtn) ? null : act('redo', 'redo', () => undo.redo(), MAC ? '⇧⌘Z' : 'ctrl+shift+Z', readOnly || !undo.redoStack.length),
      shown(metro.el) ? null : act('metronome', 'metronome', toggleClick, undefined, readOnly, metro.get()),
      shown(countBtn.el) || readOnly ? null : act('metronome', 'count-in (one bar)', () => countBtn.el.click(), undefined, false, countInOn),
      shown(keysBtn.el) || !q ? null : act('keyboard', 'computer keyboard', () => keysBtn.el.click(), '⇧K', false, !!q?.on),
      shown(pedalBtn.el) || readOnly ? null : act('power', 'loop pedal', () => void st.pedal.set(!st.pedal.on), '', !!st.pedal.why() && !st.pedal.on, st.pedal.on),
      shown(browserBtn.el) ? null : act('browser', 'browser', () => st.setUi({ browserOpen: !st.ui.browserOpen }), 'B', false, st.ui.browserOpen),
      shown(dockBtn.el) ? null : act('dock', 'editor dock', () => st.setUi({ dock: { ...st.ui.dock, open: !st.ui.dock.open } }), 'D', false, st.ui.dock.open),
    ].filter(Boolean)
    const always = [
      act('zoom-in', 'zoom to fit', () => dispatchEvent(new Event(ZOOM_FIT)), 'Z'),
      shown(title) ? null : act('settings', 'project settings', () => openProject(moreBtn)),
      shown(exportBtn) ? null : act('export', 'export…', doExport),
      shown(helpBtn) ? null : act('help', 'shortcuts and help', help, '?'),
    ].filter(Boolean)
    const sep = () => h('div', { className: 'sep' })
    const panel = h('div', { className: 'tb-pop more-panel' },
      ...rows, rows.length && (acts.length || always.length) ? sep() : null, ...acts, acts.length ? sep() : null, ...always)
    const close = popoverPanel(moreBtn, panel)
  }

  // ---------------------------------------------------------------- count-in
  let counting = false
  let cancelCount: (() => void) | null = null
  /** One bar of click before a recording starts from stopped (resolves false when cancelled). */
  async function countIn(): Promise<boolean> {
    if (!countInOn || st.playing || st.rec.take) return true
    if (cancelCount) return cancelCount(), false // pressed again while counting: cancel
    const ctx = getCtx(st.rate)
    await ctx.resume().catch(() => {})
    const { bpm: tempo, beatsPerBar } = st.tempo()
    const beat = 60 / tempo
    const t0 = ctx.currentTime + 0.08
    const out = ctx.createGain()
    out.gain.value = 0.35
    out.connect(ctx.destination)
    const oscs: OscillatorNode[] = []
    for (let i = 0; i < beatsPerBar; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = i === 0 ? 1760 : 1320
      g.gain.setValueAtTime(0, t0 + i * beat)
      g.gain.linearRampToValueAtTime(1, t0 + i * beat + 0.002)
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * beat + 0.06)
      o.connect(g).connect(out)
      o.start(t0 + i * beat)
      o.stop(t0 + i * beat + 0.08)
      oscs.push(o)
    }
    counting = true
    counter.classList.add('counting')
    return new Promise<boolean>((resolve) => {
      const timers: number[] = []
      const finish = (go: boolean) => {
        timers.forEach(clearTimeout)
        if (!go) oscs.forEach((o) => { try { o.stop() } catch { /* (already stopped) */ } })
        setTimeout(() => out.disconnect(), 200)
        counting = false
        cancelCount = null
        counter.classList.remove('counting')
        drawCounter(st.position(), true)
        resolve(go)
      }
      cancelCount = () => finish(false)
      const lead = (t0 - ctx.currentTime) * 1000
      for (let i = 0; i < beatsPerBar; i++) {
        timers.push(window.setTimeout(() => {
          cMain.textContent = `−${beatsPerBar - i}`
          cSub.textContent = 'count-in'
        }, lead + i * beat * 1000))
      }
      timers.push(window.setTimeout(() => finish(true), lead + beatsPerBar * beat * 1000 - 15))
    })
  }
  st.beforeRecord = countIn

  // ---------------------------------------------------------------- state -> controls
  /** The pedal needs Web MIDI (not in Safari) and a chosen input; otherwise the button says why it is off. */
  function syncTransport() {
    const why = st.pedal.why()
    pedalBtn.el.disabled = !!why && !st.pedal.on
    tooltip(pedalBtn.el, why || 'loop pedal: foot switches record, loop and overdub on the beat (keys 1-4 do the same)')
    pedalBtn.set(st.pedal.on)
    const playing = st.playing
    play.replaceChildren(icon(playing ? 'stop' : 'play'))
    play.classList.toggle('playing', playing)
    const recording = !!st.rec.take || st.midi.active
    rec.set(recording)
    const said = recording ? 'recording' : playing ? 'playing' : 'stopped'
    if (live.dataset.said !== said) { live.dataset.said = said; if (said !== 'playing' || live.textContent) live.textContent = said }
    rec.el.classList.toggle('armed', !!st.ui.armedTrack && !st.rec.take && !st.midi.active)
    el.classList.toggle('recording', !!st.rec.take || st.midi.active)
    drawPedalText()
    drawCounter(st.position(), true)
  }
  /** The text beside the right group says what the pedal is doing. */
  function drawPedalText() {
    const v = st.pedal.view()
    const now = st.position()
    const n = (v?.loops ?? []).filter((l) => l.stopAt == null || l.stopAt > now).length
    const text = !st.pedal.on ? '' : v?.layer ? 'pedal · rec' : v ? `pedal · ${n ? `${n} loop${n > 1 ? 's' : ''}` : 'ready'}` : 'pedal · ready'
    if (pedalText.textContent !== text) pedalText.textContent = text
    pedalText.classList.toggle('rec', !!v?.layer)
  }
  function drawMeta() {
    const t = st.tempo()
    bpm.set(t.bpm)
    meterBtn.textContent = `${t.beatsPerBar}/4`
    const loop = getLoop(doc)
    loopBtn.set(!!loop?.on)
    drawCounter(st.position(), true)
  }
  function drawDoc() {
    metro.set(getTracks(doc).some((t) => t.role === 'click' && !t.muted)) // lit: a click track exists and is unmuted
    presence?.replaceChildren(...[s.user, ...st.remote.map((r) => r.user)].map((u) =>
      h('span', { className: 'dot', title: u.username, style: `background:${u.color}` }, initials(u.username))))
    rec.set(!!st.rec.take || st.midi.active)
    drawMeta()
  }
  function drawUi() {
    const g = st.ui.grid
    snapBtn.set(!!g)
    snapSize.firstElementChild!.textContent = g ? gridLabel(g) : 'off'
    snapSize.classList.toggle('off', !g)
    view.set(st.ui.view)
    browserBtn.set(st.ui.browserOpen)
    dockBtn.set(st.ui.dock.open)
  }
  function drawUndo() {
    undoBtn.disabled = readOnly || !undo.undoStack.length
    redoBtn.disabled = readOnly || !undo.redoStack.length
  }

  // ---------------------------------------------------------------- saved state
  let saveTimer = 0
  const setSaved = (state: 'saved' | 'saving' | 'offline') => {
    saved.dataset.state = state
    savedText.textContent = state === 'saving' ? 'saving…' : state
  }
  const onUpdate = () => {
    if (s.provider) return
    setSaved('saving')
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => setSaved('saved'), 600)
  }
  doc.on('update', onUpdate)
  const onUnsynced = () => { if (s.provider?.unsyncedChanges) setSaved('saving'); else if (saved.dataset.state !== 'offline') setSaved('saved') }
  const onStatus = ({ status }: { status: string }) => {
    el.dataset.status = status
    if (status === 'disconnected') setSaved('offline')
    else if (status === 'connected') onUnsynced()
  }
  const onAuthFail = () => st.status('no access')
  s.provider?.on('status', onStatus)
  s.provider?.on('unsyncedChanges', onUnsynced)
  s.provider?.on('authenticationFailed', onAuthFail)

  // ---------------------------------------------------------------- keys: L, T, Z, X, ⌘+ / ⌘-
  const zoom = (f: number) => st.setUi({ pps: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.ui.pps * f)) })
  const offKeys = registerKeys(st, [
    { key: ['=', '+'], mods: { mod: true }, repeat: true, run: () => zoom(1.5), label: 'zoom in', group: 'View', readOnly: true },
    { key: '-', mods: { mod: true }, repeat: true, run: () => zoom(1 / 1.5), label: 'zoom out', group: 'View', readOnly: true },
    { key: 'x', label: 'arrange / mix', group: 'View', readOnly: true, run: () => st.setUi({ view: st.ui.view === 'arrange' ? 'mix' : 'arrange' }) },
    { key: 'l', run: () => toggleLoop(st), label: 'loop on / off', group: 'Transport' },
    { key: 't', run: (e) => tap(e.timeStamp), label: 'tap tempo', group: 'Transport' },
    { key: 'z', run: () => dispatchEvent(new Event(ZOOM_FIT)), label: 'zoom to fit', group: 'View', readOnly: true },
    { key: 'home', run: () => st.rewind(), label: 'back to the start', group: 'Transport', readOnly: true },
  ])

  const meta = metaMap(doc)
  meta.observe(drawMeta)
  const undoEvents = ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const
  undoEvents.forEach((ev) => undo.on(ev, drawUndo))
  const offs = [
    st.on('transport', syncTransport),
    st.on('ui', (p) => { if ('armedTrack' in p) syncTransport(); drawUi() }),
    st.on('doc', drawDoc),
    // a recording that could not start says why, on the record button (D4)
    st.on('recordError', (text) => {
      const anchor = rec.el.getClientRects().length ? rec.el : moreBtn
      const close = popoverPanel(anchor, h('div', { className: 'tb-pop tb-hint-pop', role: 'alert' }, text))
      setTimeout(close, 8000)
    }),
    st.on('tick', (p) => { drawCounter(p); drawPedalText() }),
    st.on('cpu', (m) => {
      const t = `cpu ${Math.round(m.load * 100)}%`
      if (cpu.textContent !== t) cpu.textContent = t
      cpu.classList.toggle('hot', m.peak >= 0.8)
    }),
  ]
  // The keyboard instrument mounts after the bar: follow it once it exists.
  let offKeysState: (() => void) | null = null
  queueMicrotask(() => { offKeysState = qwertyOf(st)?.onChange(drawKeys) ?? null; drawKeys() })
  /**
   * Once per device: a note key pressed with the computer keyboard off, while an instrument track is focused, says how to
   * play it. (The key still does its usual job.)
   */
  const KEYS_HINT = 'mobdaw.keysHint'
  let hinted = false
  try { hinted = localStorage.getItem(KEYS_HINT) === '1' } catch { /* (not remembered) */ }
  const onNoteKey = (e: KeyboardEvent) => {
    if (hinted || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(e) || !(e.code in QWERTY_KEYS)) return
    const q = qwertyOf(st)
    const ft = st.ui.focusTrack
    if (!q || q.on || !ft || tracksMap(doc).get(ft)?.get('kind') !== 'midi') return
    hinted = true
    try { localStorage.setItem(KEYS_HINT, '1') } catch { /* (not remembered) */ }
    const close = popoverPanel(keysBtn.el.isConnected && keysBtn.el.getClientRects().length ? keysBtn.el : moreBtn,
      h('div', { className: 'tb-pop tb-hint-pop' }, 'Turn on keys (⇧K) to play this instrument from your keyboard.'))
    setTimeout(close, 6000)
  }
  window.addEventListener('keydown', onNoteKey)
  syncTransport()
  drawDoc()
  drawUi()
  drawUndo()
  return {
    el,
    /** The chat's unread count, on its toggle. */
    setUnread(n: number) { if (chatBtn) chatBtn.querySelector('.chat-n')!.textContent = n ? String(n) : '' },
    destroy() {
      offs.forEach((f) => f())
      cancelCount?.()
      if (st.beforeRecord === countIn) st.beforeRecord = null
      offKeys()
      offKeysState?.()
      window.removeEventListener('keydown', onNoteKey)
      meta.unobserve(drawMeta)
      undoEvents.forEach((ev) => undo.off(ev, drawUndo))
      doc.off('update', onUpdate)
      clearTimeout(saveTimer)
      cancelAnimationFrame(bpmRaf)
      scope.destroy()
      section.destroy()
      s.provider?.off('status', onStatus)
      s.provider?.off('unsyncedChanges', onUnsynced)
      s.provider?.off('authenticationFailed', onAuthFail)
    },
  }
}
