// Device panels for the dock's rack: each device is a hardware-like unit with a header (grip to reorder, power, name,
// preset menu, collapse, remove) and its params as knobs, laid out per device: the finnwave's envelope as a row under a
// drawing of it, the EQ's bands as columns under the response curve, the compressor next to its transfer curve.
// Drums get a compact pad (`drumPad`) that the rack lines up inside a kit panel.
//
// Behaviour kept from the old cards: a param's label (or a right-click on its knob) offers automate / LFO; dragging
// a knob plays the value live and shows it to collaborators, and lets go into the doc as one undo step; a param a lane
// drives follows the lane and can't be dragged; other users' drags show on the knobs; instruments have a key range.
import {
  COMPRESSOR, DELAY, DEVICES, DRUM_SYNTH, EQ, FINNWAVE, KEY_MAX, KEY_MIN, LOFI_DRUM, REVERB, SIMPLE_FILTER, TREMOLO, filterHasGain,
  type Device, type ParamDef, type ParamTarget,
} from '@mobdaw/shared'
import { h } from '../dom'
import { formatValue, knob, segmented, type Knob } from '../theme/controls'
import { icon } from '../theme/icons'
import { NO_AUTO, type AutoInfo } from './automation'
import { FILTER_COLORS, filterCurve, type FilterChange, type FilterLocks, type FilterMember } from './filterCurve'
import { noteName, parseNote } from './noteName'
import { popover, type MenuItem } from './popover'
import { dragToReorder } from './reorder'
import { DRUM_GROUPS, drumDrawing, drumKnobName } from './drumParts'

export type CardDeps = {
  readOnly: boolean
  /** Apply a value to the local engine immediately (not in the doc). */
  live(deviceId: string, paramId: number, value: number): void
  /** Publish (or clear, with null) the in-progress drag for collaborators. */
  drag(d: { deviceId: string; paramId: number; value: number }[] | null): void
  /** Write the final value to the doc (one undo step). */
  commit(deviceId: string, paramId: number, value: number): void
  /** Write several params at once (one undo step). */
  commitMany(deviceId: string, values: Record<number, number>): void
  bypass(deviceId: string, bypass: boolean): void
  remove(deviceId: string): void
  /** Instruments: set the note range (MIDI pitches, inclusive), and rename the device. */
  keys(deviceId: string, lo: number, hi: number): void
  rename(deviceId: string): void
  /** The run of adjacent filters this one is in, in chain order, with `self` standing in for it. */
  run(deviceId: string, self: FilterMember): FilterMember[]
  /** This filter's values changed: the other filters of its run redraw their curves. */
  changed(deviceId: string): void
  /** A panel is being dragged by its grip; dropped before `beforeId` (null: last). */
  reorderStart(): void
  reorderDrop(deviceId: string, beforeId: string | null): void
  reorderEnd(): void
  /** A run's curve is moving a param of filter `deviceId` (any panel in the run), and finished moving it. */
  dragFilter(deviceId: string, change: FilterChange): void
  dragFilterEnd(deviceId: string): void
  /** Make a param's label offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: ParamTarget): void
  /** The panel's preset menu (null: none), and the preset its values match now. */
  presets(dev: Device): { menu: ((anchor: HTMLElement) => void) | null; current: string | null }
  /** Whether the panel is shown collapsed, and to change it. */
  collapsed(deviceId: string): boolean
  setCollapsed(deviceId: string, on: boolean): void
  /** Play a drum or note on the device's track (on / off). */
  audition?(trackId: string, pitch: number, on: boolean): void
  /** A control is moving a param live: the device's other views (a drum's pad and its editor) follow it. */
  mirror?(deviceId: string, paramId: number, value: number): void
  /** Drums: a pad's face was pressed (the rack selects it for the drum editor). */
  selectDrum?(deviceId: string): void
  /** Drum synth: step to the previous / next sound in the current sound's category (and hear it). */
  stepSound?(deviceId: string, dir: 1 | -1): void
}

export const fmt = (p: ParamDef, v: number) => {
  if (p.unit === ':1') return `${v < 10 ? v.toFixed(1) : Math.round(v)}:1`
  if (p.unit === '×') return `${v.toFixed(2)}×`
  if (!p.unit && p.max <= 2 && p.min >= 0 && p.name !== 'rolloff' && !p.name.includes('damping')) return `${Math.round(v * 100)}%`
  return formatValue(v, p.unit)
}

/** Short knob labels where the catalogue's names are long. */
const SHORT: Record<string, string> = { 'env→rolloff': 'env amt', resonance: 'res', predelay: 'pre-delay', threshold: 'thresh' }
/** Each device's knob groups (param ids), in order; params left out go in a last group. */
export type Group = { label?: string; ids: number[]; draw?: 'adsr' | 'comp' | 'drum' }
const LAYOUT: Record<number, Group[]> = {
  [FINNWAVE]: [{ label: 'tone', ids: [0, 1] }, { label: 'envelope', ids: [2, 3, 4, 5], draw: 'adsr' }, { label: 'out', ids: [6] }],
  [LOFI_DRUM]: [{ label: 'tone', ids: [0, 1] }, { label: 'body', ids: [2, 3] }],
  [REVERB]: [{ ids: [0, 1, 2, 3] }],
  [COMPRESSOR]: [{ ids: [0, 1], draw: 'comp' }, { label: 'time', ids: [2, 3] }, { label: 'out', ids: [4] }],
  [TREMOLO]: [{ ids: [2, 0, 1, 3] }],
  [DELAY]: [{ label: 'echo', ids: [1, 2, 0] }, { label: 'tape', ids: [3, 4] }, { label: 'tone', ids: [5, 6, 7] }],
  [SIMPLE_FILTER]: [{ ids: [0, 1, 2, 3] }],
  // a drum synth over a key range is tuned percussion, shown as a normal panel (as a drum it gets a pad and the drum editor)
  [DRUM_SYNTH]: DRUM_GROUPS.map((g, i) => ({ ...g, draw: i === 0 ? 'drum' as const : undefined })),
}
const EQ_BANDS = ['low', 'bell 1', 'bell 2', 'high']
const EQ_MODES = [6, 5, 5, 7] // low shelf, bell, bell, high shelf (engine device.rs, kind 8)
const EQ_COLORS = ['#e0896a', '#d9a648', '#58b4a8', '#6c9bd6']
const SVGNS = 'http://www.w3.org/2000/svg'
export const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** One param's control: a knob, or (for choices) a segmented switch / a compact select. */
export type Ctl = {
  p: ParamDef
  el: HTMLElement
  /** The element whose click / right-click offers automation (null: choices can't be automated). */
  label: HTMLElement | null
  set(v: number): void
  /** Change the shown name (the drum synth's knobs whose meaning follows its model). */
  rename(name: string): void
  disable(d: boolean): void
  active(): boolean
}

function paramCtl(p: ParamDef, o: { size: number; name?: string; bipolar?: boolean; disabled: boolean; input(v: number): void; change(v: number): void }): Ctl {
  if (p.options) {
    const name = h('span', { className: 'pc-name' }, o.name ?? p.name)
    if (p.options.length <= 3) {
      const seg = segmented(p.options.map((label, i) => ({ value: String(i), label: label.replace('pass', '') })), '0', (v) => (o.input(Number(v)), o.change(Number(v))))
      seg.el.classList.add('sm')
      const el = h('div', { className: 'pc choice' }, seg.el, name)
      const disable = (d: boolean) => seg.el.querySelectorAll('button').forEach((b) => (b.disabled = d))
      disable(o.disabled)
      return { p, el, label: null, set: (v) => seg.set(String(Math.round(v))), rename: (t) => (name.textContent = t), disable, active: () => false }
    }
    const sel = h('select', { className: 'pc-select', disabled: o.disabled }, ...p.options.map((label, i) => h('option', { value: String(i) }, label))) as HTMLSelectElement
    sel.onchange = () => (o.input(Number(sel.value)), o.change(Number(sel.value)))
    sel.onkeydown = (e) => e.stopPropagation()
    const el = h('div', { className: 'pc choice' }, sel, name)
    return {
      p, el, label: null, set: (v) => (sel.value = String(Math.round(v))), rename: (t) => (name.textContent = t),
      disable: (d) => (sel.disabled = d), active: () => document.activeElement === sel,
    }
  }
  const value = h('span', { className: 'pc-value' })
  let k: Knob
  let dragging = false
  k = knob({
    value: p.def, min: p.min, max: p.max, def: p.def, scale: p.scale, label: o.name ?? SHORT[p.name] ?? p.name, size: o.size,
    format: (v) => fmt(p, v), title: p.name, disabled: o.disabled, bipolar: o.bipolar,
    onInput: (v) => { dragging = true; value.textContent = fmt(p, v); o.input(v) },
    onChange: (v) => { dragging = false; value.textContent = fmt(p, v); o.change(v) },
  })
  const label = k.el.querySelector<HTMLElement>('.knob-label')!
  // a drag that ends over the label is not a click on it (the label's click opens the automation menu)
  let down: [number, number] | null = null
  k.el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]), true)
  k.el.addEventListener('click', (e) => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 3) e.stopPropagation()
  }, true)
  // right-click anywhere on the knob: the label's menu
  k.el.addEventListener('contextmenu', (e) => {
    if (e.target === label) return
    e.preventDefault()
    e.stopPropagation()
    label.dispatchEvent(new MouseEvent('contextmenu', { clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }))
  })
  const el = h('div', { className: 'pc' }, k.el, value)
  return {
    p, el, label,
    set: (v) => { k.set(v); if (!dragging) value.textContent = fmt(p, v) },
    rename: (t) => { if (label.textContent !== t) (label.textContent = t, k.el.setAttribute('aria-label', t)) },
    disable: (d) => k.setDisabled(d),
    active: () => dragging,
  }
}

/**
 * A device's params as controls, with the plumbing every view of a device shares: a drag plays the value live, shows it
 * to collaborators (and to the device's other views, `deps.mirror`) and lets go into the doc as one undo step; a
 * knob's label offers automation; `update` shows the doc, other users' drags and the lanes (a param a lane drives
 * follows the lane and can't be dragged). `redraw` runs whenever a shown value changes; `held` keeps still a param
 * that something else (the filter curve) is moving.
 */
export function paramSet(dev: Device, deps: CardDeps, o: { redraw?(): void; held?(pid: number): boolean } = {}) {
  const def = DEVICES[dev.type]
  const id = dev.id
  const kind = def?.instrument ? 'synth' : 'effect'
  /** What each param currently shows (doc, automation, a remote drag or this view's own drag). */
  const shown = new Map<number, number>()
  /** Params a lane drives. */
  const driven = new Set<number>()
  const ctls = new Map<number, Ctl>()
  const redraw = () => o.redraw?.()
  const pdef = (pid: number) => def!.params.find((p) => p.id === pid)!
  const val = (pid: number) => shown.get(pid) ?? def?.params.find((p) => p.id === pid)?.def ?? 0
  const make = (p: ParamDef, size = 36, name?: string, bipolar?: boolean) => {
    const c = paramCtl(p, {
      size, name, bipolar, disabled: deps.readOnly,
      input: (v) => {
        shown.set(p.id, v)
        deps.live(id, p.id, v)
        deps.drag([{ deviceId: id, paramId: p.id, value: v }])
        deps.mirror?.(id, p.id, v)
        redraw()
      },
      change: (v) => {
        shown.set(p.id, v)
        deps.commit(id, p.id, v)
        deps.drag(null)
        redraw()
      },
    })
    if (c.label) deps.autoMenu(c.label, { scope: dev.trackId, kind, owner: id, param: String(p.id) })
    ctls.set(p.id, c)
    return c.el
  }
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo>) {
    driven.clear()
    for (const p of def?.params ?? []) {
      const c = ctls.get(p.id)
      const a = auto.get(String(p.id))
      const drive = !!a?.on && a.value != null
      if (drive) driven.add(p.id)
      const v = (drive ? a!.value : null) ?? remote.get(p.id) ?? d.params?.[p.id] ?? p.def
      if (!c) { shown.set(p.id, v); continue } // (no control here, but drawings may use it)
      c.label?.classList.toggle('auto', !!a)
      c.el.classList.toggle('driven', drive)
      c.disable(deps.readOnly || drive)
      // a driven control follows the lane even mid-drag
      if (drive || (!c.active() && !o.held?.(p.id))) {
        shown.set(p.id, v)
        c.set(v)
      }
    }
  }
  /** Another view of this device is moving a param: follow it (unless this view is moving it too, or a lane drives it). */
  function show(pid: number, v: number) {
    const c = ctls.get(pid)
    if (driven.has(pid) || c?.active()) return
    shown.set(pid, v)
    c?.set(v)
    redraw()
  }
  return { ctls, shown, driven, val, pdef, make, update, show }
}

/** The finnwave's envelope as a little drawing: attack, decay to the sustain level, a held stretch, release. */
function adsrDrawing() {
  const W = 168, H = 36
  const fill = svg('path', { class: 'adsr-fill' })
  const line = svg('path', { class: 'adsr-line' })
  const el = svg('svg', { class: 'adsr', viewBox: `0 0 ${W} ${H}`, width: W, height: H })
  el.append(fill, line)
  const span = (ms: number) => Math.sqrt(Math.max(0, ms) / 5000) * 46 // short times stay visible
  return {
    el,
    draw(a: number, d: number, s: number, r: number) {
      const x1 = 2 + span(a), x2 = x1 + span(d), x3 = x2 + 28, x4 = Math.min(W - 2, x3 + span(r) * 0.8)
      const y = (v: number) => 2 + (1 - v) * (H - 4)
      const pts = `M2 ${H - 1}L${x1.toFixed(1)} ${y(1)}L${x2.toFixed(1)} ${y(s).toFixed(1)}L${x3.toFixed(1)} ${y(s).toFixed(1)}L${x4.toFixed(1)} ${H - 1}`
      line.setAttribute('d', pts)
      fill.setAttribute('d', `${pts}Z`)
    },
  }
}

/** The compressor's static curve: input level across, output up, the knee at the threshold. */
function compDrawing() {
  const S = 64
  const grid = svg('path', { class: 'comp-grid', d: `M0 ${S}L${S} 0M0 ${S / 2}H${S}M${S / 2} 0V${S}` })
  const line = svg('path', { class: 'comp-line' })
  const knee = svg('circle', { class: 'comp-knee', r: 2.5 })
  const el = svg('svg', { class: 'comp', viewBox: `0 0 ${S} ${S}`, width: S, height: S })
  el.append(grid, line, knee)
  const xy = (db: number) => S - ((db + 60) / 60) * S
  return {
    el,
    draw(thr: number, ratio: number, makeup: number) {
      const out = (i: number) => Math.min(6, (i < thr ? i : thr + (i - thr) / ratio) + makeup)
      line.setAttribute('d', `M0 ${xy(out(-60)).toFixed(1)}L${(S - xy(thr)).toFixed(1)} ${xy(out(thr)).toFixed(1)}L${S} ${xy(out(0)).toFixed(1)}`)
      knee.setAttribute('cx', (S - xy(thr)).toFixed(1))
      knee.setAttribute('cy', xy(out(thr)).toFixed(1))
    },
  }
}

/** The header shared by the panels: grip, power, name (click: its menu), preset menu, collapse, remove. */
/** What kind of device a renamed panel is, in dim text after its name ("synth", "Reverb"). */
const typeLabel = (type: number) => (type === FINNWAVE ? 'synth' : type === LOFI_DRUM || type === DRUM_SYNTH ? 'drum' : DEVICES[type]?.name ?? '')

export function unitHead(dev: Device, deps: CardDeps, el: HTMLElement, more: () => MenuItem[] = () => []) {
  const def = DEVICES[dev.type]
  const kind = def?.instrument ? 'instrument' : 'effect'
  const typeEl = h('span', { className: 'unit-type' })
  const grip = h('span', { className: 'unit-grip', title: 'drag to move' }, icon('grip', 14))
  const power = h('button', { className: 'unit-power', title: `${kind} on / off (bypass)`, role: 'switch', disabled: deps.readOnly }, h('i', { className: 'lamp' }))
  const name = h('button', { className: 'unit-name', title: `${def?.name ?? 'device'}: click for its menu` })
  const preset = h('button', { className: 'unit-preset', title: 'presets' }, h('span', {}), icon('chevron-down', 12))
  const collapse = h('button', { className: 'unit-fold icon-btn sm', title: 'collapse' }, icon('chevron-down', 14))
  const remove = h('button', { className: 'unit-remove icon-btn sm', title: `remove this ${kind}`, disabled: deps.readOnly }, icon('close', 14))
  const head = h('div', { className: 'unit-head' }, grip, power, name, typeEl, preset, h('span', { className: 'grow' }), collapse, remove)
  let current = dev
  power.onclick = () => deps.bypass(dev.id, !current.bypass)
  remove.onclick = () => deps.remove(dev.id)
  collapse.onclick = (e) => { e.stopPropagation(); deps.setCollapsed(dev.id, !deps.collapsed(dev.id)) }
  const menu = (at: [number, number] | undefined, anchor: HTMLElement) => {
    if (deps.readOnly) return
    const items: MenuItem[] = [
      { label: 'rename', run: () => deps.rename(dev.id), icon: 'edit' },
      { label: current.bypass ? 'turn on' : 'turn off (bypass)', run: () => deps.bypass(dev.id, !current.bypass), icon: 'power' },
      { label: deps.collapsed(dev.id) ? 'expand' : 'collapse', run: () => deps.setCollapsed(dev.id, !deps.collapsed(dev.id)) },
      ...more(),
      'sep',
      { label: `remove ${kind}`, run: () => deps.remove(dev.id), icon: 'trash', danger: true },
    ]
    popover(anchor, items, at)
  }
  name.onclick = () => menu(undefined, name)
  el.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.knob, select, input')) return
    e.preventDefault()
    e.stopPropagation()
    menu([e.clientX, e.clientY], el)
  })
  preset.onclick = () => deps.presets(current).menu?.(preset)
  // a collapsed panel opens again from anywhere on its strip
  el.addEventListener('click', (e) => {
    if (el.classList.contains('collapsed') && !(e.target as HTMLElement).closest('.unit-power, .unit-remove')) deps.setCollapsed(dev.id, false)
  })
  if (!deps.readOnly) dragToReorder(grip, el, { start: deps.reorderStart, drop: (before) => deps.reorderDrop(dev.id, before), end: deps.reorderEnd })
  return {
    head,
    update(d: Device) {
      current = d
      const text = d.name ?? def?.name ?? `device ${d.type}`
      if (name.textContent !== text) name.textContent = text
      power.setAttribute('aria-checked', String(!d.bypass))
      el.classList.toggle('bypassed', !!d.bypass)
      const p = deps.presets(d)
      preset.hidden = !p.menu || deps.readOnly
      // the name already says which preset it is: the menu button shrinks to its chevron, and the type follows the name
      const same = !!p.current && p.current === text
      const label = same ? '' : p.current ?? 'preset'
      const span = preset.firstElementChild as HTMLElement
      if (span.textContent !== label) span.textContent = label
      preset.classList.toggle('none', !p.current)
      preset.classList.toggle('only-chev', same)
      preset.title = same ? `presets (now: ${text})` : 'presets'
      const type = d.name && d.name !== def?.name ? typeLabel(d.type) : ''
      if (typeEl.textContent !== type) typeEl.textContent = type
      typeEl.hidden = !type
      const shut = deps.collapsed(d.id)
      el.classList.toggle('collapsed', shut)
      collapse.title = shut ? 'expand' : 'collapse'
      el.title = shut ? `${text}: click to expand` : ''
    },
  }
}

/** A device's panel. The API matches what the rack needs: update from the doc, refresh from automation, and the filter-run hooks. */
export function deviceCard(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  const el = h('div', { className: `unit t${dev.type}`, 'data-device': id })
  let rangeOpen = false // the key range shows when it is set, or when asked for from the panel's menu
  const head = unitHead(dev, deps, el, () => def?.instrument && !deps.readOnly ? [{ label: rangeOpen ? 'hide the key range' : 'key range…', run: () => { rangeOpen = !rangeOpen; drawRange() } }] : [])
  let current = dev

  let nodeDrag: Map<number, number> | null = null
  const extras: (() => void)[] = [] // drawings (and labels) that follow the values
  const ps = paramSet(dev, deps, { redraw: () => redraw(), held: (pid) => nodeDrag?.get(pid) != null })
  /** `driven`: params a lane drives (the curve can't move those). */
  const { shown, driven, ctls, val, pdef } = ps
  const make = (p: ParamDef, size = 36, name?: string) => ps.make(p, size, name)

  // --- the filter curve (a simple filter shows its whole run; the EQ its four bands)
  let curve: ReturnType<typeof filterCurve> | null = null
  const locksOf = (cut: number, damp: number, gain: number): FilterLocks =>
    ({ cutoff: deps.readOnly || driven.has(cut), damping: deps.readOnly || driven.has(damp), gain: deps.readOnly || driven.has(gain) })
  const member = (): FilterMember => ({
    id, mode: val(0), cutoff: val(1), damping: val(2), gain: val(3), bypass: !!current.bypass, locks: locksOf(1, 2, 3), row: 0,
  })
  const eqMembers = (): FilterMember[] => EQ_BANDS.map((_, i) => ({
    id: `${id}#${i}`, mode: EQ_MODES[i], cutoff: val(i * 3), damping: val(i * 3 + 2), gain: val(i * 3 + 1), bypass: !!current.bypass,
    locks: locksOf(i * 3, i * 3 + 2, i * 3 + 1), row: 0,
  }))
  /** The curve moves params: apply them to the knobs and the engine now, commit when it lets go. */
  const dragMove = (change: FilterChange, band = -1) => {
    nodeDrag ??= new Map()
    const ids = band < 0 ? [1, 2, 3] : [band * 3, band * 3 + 2, band * 3 + 1]
    for (const [pid, v] of [[ids[0], change.cutoff], [ids[1], change.damping], [ids[2], change.gain]] as const) if (v != null) nodeDrag.set(pid, v)
    for (const [pid, v] of nodeDrag) {
      deps.live(id, pid, v)
      shown.set(pid, v)
      ctls.get(pid)?.set(v)
    }
    deps.drag([...nodeDrag].map(([paramId, value]) => ({ deviceId: id, paramId, value })))
    redraw()
  }
  const dragEnd = () => {
    if (nodeDrag) deps.commitMany(id, Object.fromEntries(nodeDrag))
    deps.drag(null)
    nodeDrag = null
  }
  let told = ''
  const redrawCurve = () => {
    if (!curve) return
    if (dev.type === EQ) return curve.draw(eqMembers(), EQ_COLORS, 470)
    const run = deps.run(id, member())
    curve.draw(run, run.map((_, k) => (run.length > 1 ? FILTER_COLORS[k % FILTER_COLORS.length] : null)), 216)
    const at = run.findIndex((m) => m.id === id)
    el.style.setProperty('--run-c', run.length > 1 && at >= 0 ? FILTER_COLORS[at % FILTER_COLORS.length] : '')
  }
  function redraw() {
    extras.forEach((f) => f())
    if (!curve) return
    redrawCurve()
    if (dev.type === SIMPLE_FILTER) {
      const now = JSON.stringify(member())
      if (now !== told) (told = now, deps.changed(id))
      const g = ctls.get(3)
      if (g) g.el.classList.toggle('off', !filterHasGain(val(0)))
    }
  }

  // --- the body, per device
  const body = h('div', { className: 'unit-body' })
  if (dev.type === EQ && def) {
    curve = filterCurve({ height: 78, move: (fid, change) => dragMove(change, Number(fid.split('#')[1])), end: () => dragEnd() })
    const cols = EQ_BANDS.map((band, i) => h('div', { className: 'eq-col', style: `--c:${EQ_COLORS[i]}` },
      h('div', { className: 'eq-band' }, band),
      h('div', { className: 'eq-pair' }, make(pdef(i * 3), 32, 'freq'), make(pdef(i * 3 + 1), 32, 'gain')), make(pdef(i * 3 + 2), 24, 'q')))
    cols.push(h('div', { className: 'eq-col out' }, h('div', { className: 'eq-band' }, 'out'), make(pdef(12), 32, 'output')))
    body.append(h('div', { className: 'unit-plot' }, curve.el), h('div', { className: 'eq-cols' }, ...cols))
  } else if (def) {
    if (dev.type === SIMPLE_FILTER) {
      curve = filterCurve({ height: 86, move: (fid, change) => deps.dragFilter(fid, change), end: (fid) => deps.dragFilterEnd(fid) })
      body.append(h('div', { className: 'unit-plot' }, curve.el))
    }
    const groups = LAYOUT[dev.type] ?? [{ ids: def.params.map((p) => p.id) }]
    const used = new Set(groups.flatMap((g) => g.ids))
    const rest = def.params.filter((p) => !used.has(p.id)).map((p) => p.id)
    const row = h('div', { className: 'unit-groups' })
    for (const g of rest.length ? [...groups, { ids: rest }] : groups) {
      const drum = dev.type === DRUM_SYNTH
      const knobs = h('div', { className: 'unit-knobs' }, ...g.ids.map((pid) => drum
        ? ps.make(pdef(pid), 36, drumKnobName(pid, 0), pdef(pid).min < 0)
        : make(pdef(pid), dev.type === FINNWAVE ? 38 : 36)))
      const box = h('div', { className: 'unit-group' })
      if (g.label) box.append(h('div', { className: 'unit-glabel' }, g.label))
      if (g.draw === 'drum') {
        const d = drumDrawing()
        extras.push(() => {
          d.draw(val)
          for (const pid of [5, 6]) ctls.get(pid)?.rename(drumKnobName(pid, val(0)))
        })
        box.append(h('div', { className: 'unit-draw' }, d.el))
      }
      if (g.draw === 'adsr') {
        const d = adsrDrawing()
        extras.push(() => d.draw(val(2), val(3), val(4), val(5)))
        box.append(h('div', { className: 'unit-draw' }, d.el))
      }
      if (g.draw === 'comp') {
        const d = compDrawing()
        extras.push(() => d.draw(val(0), val(1), val(4)))
        box.classList.add('with-side')
        box.append(h('div', { className: 'unit-side' }, d.el, knobs))
      } else box.append(knobs)
      row.append(box)
    }
    body.append(row)
  }

  // Instruments take the notes inside their range: lo and hi note names (c2, f#3, or a pitch number).
  const keyIn = (tip: string) => h('input', { className: 'key', title: tip, spellcheck: false, disabled: deps.readOnly })
  const lo = keyIn('lowest note'), hi = keyIn('highest note')
  const range = def?.instrument ? h('div', { className: 'unit-foot' }, h('span', { className: 'dim' }, 'Plays notes'), lo, h('span', { className: 'muted' }, 'to'), hi) : null
  const drawRange = () => {
    if (!range) return
    const full = (current.keyLo ?? KEY_MIN) <= KEY_MIN && (current.keyHi ?? KEY_MAX) >= KEY_MAX
    range.hidden = full && !rangeOpen && !range.contains(document.activeElement)
  }
  const setKeys = (which: 'lo' | 'hi') => {
    const p = parseNote((which === 'lo' ? lo : hi).value)
    const [kl, kh] = [current.keyLo ?? KEY_MIN, current.keyHi ?? KEY_MAX]
    if (p == null) return showKeys(kl, kh) // not a note: put the old one back
    deps.keys(id, which === 'lo' ? p : Math.min(kl, p), which === 'hi' ? p : Math.max(kh, p)) // the other end follows if they would cross
  }
  const showKeys = (kl: number, kh: number) => {
    if (document.activeElement !== lo) lo.value = noteName(kl)
    if (document.activeElement !== hi) hi.value = noteName(kh)
  }
  lo.onchange = () => setKeys('lo')
  hi.onchange = () => setKeys('hi')
  for (const i of [lo, hi]) i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur() }

  el.append(head.head, body)
  if (range) el.append(range)

  /**
   * `remote`: in-progress values from other users' drags, keyed by param id. `auto`: the params a lane drives, keyed
   * by param id as a string; those show the lane's value and can't be dragged.
   */
  let lastRemote = new Map<number, number>()
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = d
    lastRemote = remote
    head.update(d)
    showKeys(d.keyLo ?? KEY_MIN, d.keyHi ?? KEY_MAX)
    drawRange()
    ps.update(d, remote, auto)
    redraw()
  }
  update(dev, new Map())
  /** Repaint with new automation values only (the playhead moved). */
  const refresh = (auto: Map<string, AutoInfo>) => update(current, lastRemote, auto)
  return {
    el, update, refresh,
    /** The filter's current values, or null for other devices. */
    member: () => (dev.type === SIMPLE_FILTER ? member() : null),
    redrawCurve, dragMove: (c: FilterChange) => dragMove(c), dragEnd,
  }
}

/** The knobs a pad shows: a lofi drum's four, a drum synth's macros (the drum editor has the rest). */
const PAD_KNOBS: Record<number, [number, string][]> = {
  [LOFI_DRUM]: [[0, 'tone'], [1, 'res'], [2, 'decay'], [3, 'level']],
  [DRUM_SYNTH]: [[1, 'pitch'], [4, 'decay'], [8, 'noise'], [22, 'level']],
}

/**
 * A drum in a kit panel: a pad to hear it (its name and key), on/off, and a few knobs. Pressing the face plays the drum
 * and selects it (`deps.selectDrum`: the rack opens the drum editor on it).
 */
export function drumPad(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  let current = dev
  const name = h('span', { className: 'dpad-name' })
  const key = h('input', { className: 'dpad-key', title: 'the key this drum plays on (c2, f#3…)', spellcheck: false, disabled: deps.readOnly })
  const editable = dev.type === DRUM_SYNTH
  const face = h('div', { className: 'dpad-face', title: `click to hear it${editable ? ' and edit it' : ''}; double-click the name to rename` }, name, key)
  const power = h('button', { className: 'unit-power sm', title: 'drum on / off', role: 'switch', disabled: deps.readOnly, onclick: () => deps.bypass(id, !current.bypass) }, h('i', { className: 'lamp' }))
  const remove = h('button', { className: 'dpad-remove icon-btn sm', title: 'remove this drum', disabled: deps.readOnly, onclick: () => deps.remove(id) }, icon('close', 12))
  const ps = paramSet(dev, deps)
  const wanted = PAD_KNOBS[dev.type] ?? (def?.params ?? []).slice(0, 4).map((p): [number, string] => [p.id, SHORT[p.name] ?? p.name])
  const knobs = h('div', { className: 'dpad-knobs' }, ...wanted.map(([pid, label]) => ps.make(ps.pdef(pid), 26, label)))
  const el = h('div', { className: `dpad t${dev.type}`, 'data-device': id }, h('div', { className: 'dpad-top' }, power, remove), face, knobs)

  face.onpointerdown = (e) => {
    if (e.button !== 0 || (e.target as HTMLElement) === key) return
    deps.selectDrum?.(id)
    if (!deps.audition) return
    const k = current.keyLo ?? KEY_MIN
    face.classList.add('down')
    deps.audition(current.trackId, k, true)
    const up = () => (face.classList.remove('down'), deps.audition?.(current.trackId, k, false), removeEventListener('pointerup', up), removeEventListener('pointercancel', up))
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  name.ondblclick = () => deps.readOnly || deps.rename(id)
  key.onchange = () => {
    const p = parseNote(key.value)
    if (p == null) return void (key.value = noteName(current.keyLo ?? KEY_MIN))
    deps.keys(id, p, p)
  }
  key.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') key.blur() }
  el.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.knob')) return
    e.preventDefault()
    e.stopPropagation()
    if (deps.readOnly) return
    popover(el, [
      ...(editable && deps.selectDrum ? [{ label: 'edit', run: () => deps.selectDrum!(id), icon: 'settings' as const }] : []),
      { label: 'rename', run: () => deps.rename(id), icon: 'edit' },
      { label: current.bypass ? 'turn on' : 'turn off', run: () => deps.bypass(id, !current.bypass), icon: 'power' },
      'sep',
      { label: 'remove drum', run: () => deps.remove(id), icon: 'trash', danger: true },
    ], [e.clientX, e.clientY])
  })

  let lastRemote = new Map<number, number>()
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = d
    lastRemote = remote
    const text = d.name ?? def?.name ?? 'drum'
    if (name.textContent !== text) name.textContent = text
    if (document.activeElement !== key) key.value = noteName(d.keyLo ?? KEY_MIN)
    power.setAttribute('aria-checked', String(!d.bypass))
    el.classList.toggle('bypassed', !!d.bypass)
    ps.update(d, remote, auto)
  }
  update(dev, new Map())
  return {
    el, update, refresh: (auto: Map<string, AutoInfo>) => update(current, lastRemote, auto), member: () => null, redrawCurve: () => {}, dragMove: () => {}, dragEnd: () => {},
    /** Highlight it as the drum the editor shows. */
    select(on: boolean) { el.classList.toggle('selected', on); face.setAttribute('aria-pressed', String(on)) },
    /** The editor is moving one of its params. */
    show: ps.show,
  }
}
