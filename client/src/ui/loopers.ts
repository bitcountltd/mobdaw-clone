// One looper slot's card, a small unit in the soundscape's loopers row: a lamp (on / muted), its name in the slot colour,
// knobs for volume, speed (0.1x-4x, log), and the tape controls (saturation, low-pass filter, warble), and the region
// buttons (draw / redraw, clear). A knob's label is its automation menu, as in the device rack.
import { LOOP_CUTOFF_MAX, LOOP_CUTOFF_MIN, LOOP_SPEED_MAX, LOOP_SPEED_MIN, type Looper, type ParamTarget } from '@mobdaw/shared'
import { h } from '../dom'
import { NO_AUTO, type AutoInfo } from './automation'
import { knob, type Knob } from '../theme/controls'
import { cardMenu } from './cardHead'
import { fmtDb } from './slider'

/** Slot colours (the cards and their region boxes): from the track palette, so they sit with the rest of the console. */
export const LOOP_COLORS = ['#e0896a', '#d9a648', '#58b4a8', '#6c9bd6']

export type LooperDeps = {
  readOnly: boolean
  /** A slider drag begins (so it undoes as one step). */
  grab(): void
  /** Write the speed to the doc as the slider moves: the engine applies it live, smoothed. */
  commit(id: string, speed: number): void
  setMuted(id: string, muted: boolean): void
  /** Write the volume (0..1) to the doc as the slider moves. */
  setGain(id: string, gain: number): void
  /** Write a tape control (saturation, low-pass cutoff in Hz, warble depth) to the doc as its slider moves. */
  setTape(id: string, patch: { sat?: number; cutoff?: number; warble?: number }): void
  /** Arm / disarm drawing this looper's region on the lane. */
  toggleArm(id: string): void
  clear(id: string): void
  remove(id: string): void
  /** Make a param's name offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: ParamTarget): void
}

const RATIO = LOOP_SPEED_MAX / LOOP_SPEED_MIN
const toSpeed = (pos: number) => {
  const s = LOOP_SPEED_MIN * RATIO ** pos
  return Math.abs(s - 1) < 0.03 ? 1 : s // detent at 1x
}
const toPos = (s: number) => Math.log(s / LOOP_SPEED_MIN) / Math.log(RATIO)
const CUT_RATIO = LOOP_CUTOFF_MAX / LOOP_CUTOFF_MIN
const toCutoff = (pos: number) => LOOP_CUTOFF_MIN * CUT_RATIO ** pos
const toCutPos = (hz: number) => Math.log(hz / LOOP_CUTOFF_MIN) / Math.log(CUT_RATIO)
const fmtCutoff = (hz: number) => (hz >= LOOP_CUTOFF_MAX * 0.99 ? 'open' : hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`)
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtSpeed = (s: number) => `${s.toFixed(2)}×`

export function looperCard(lp: Looper, deps: LooperDeps) {
  const id = lp.id
  const color = LOOP_COLORS[lp.slot % LOOP_COLORS.length]
  const draw = h('button', { className: 'btn sm', title: 'draw the loop region on the track', onclick: () => deps.toggleArm(id) }, 'draw')
  const clear = h('button', { className: 'btn sm', title: 'clear the region', onclick: () => deps.clear(id) }, 'clear')
  let muted = false
  const power = h('button', { className: 'unit-power sm', role: 'switch', title: 'loop on / off', disabled: deps.readOnly, onclick: () => deps.setMuted(id, !muted) }, h('i', { className: 'lamp' }))
  draw.disabled = clear.disabled = deps.readOnly

  // knobs: the doc is written as they move (the engine smooths), one undo step per drag
  type Ctl = { k: Knob; out: HTMLElement; el: HTMLElement; label: HTMLElement; fmt: (v: number) => string; to: (v: number) => number; from: (p: number) => number; active: boolean }
  const ctls: Record<string, Ctl> = {}
  const ctl = (key: string, label: string, title: string, fmt: (v: number) => string, write: (v: number) => void,
    to: (v: number) => number = (v) => v, from: (p: number) => number = (p) => p, def = 0) => {
    const out = h('span', { className: 'pc-value' })
    const c: Ctl = { k: null as unknown as Knob, out, el: null as unknown as HTMLElement, label: null as unknown as HTMLElement, fmt, to, from, active: false }
    // the knob works in 0..1 positions (speed and cutoff are logarithmic); `from` maps a position to the value
    c.k = knob({
      value: def, min: 0, max: 1, def, label, size: 30, title, color, disabled: deps.readOnly, format: (p) => fmt(from(p)),
      onInput: (p) => { c.active = true; const v = from(p); out.textContent = fmt(v); write(v) },
      onChange: (p) => { c.active = false; out.textContent = fmt(from(p)) },
    })
    c.k.el.addEventListener('pointerdown', () => deps.grab(), true)
    c.label = c.k.el.querySelector<HTMLElement>('.knob-label')!
    deps.autoMenu(c.label, { scope: lp.trackId, kind: 'looper', owner: id, param: key })
    c.el = h('div', { className: 'pc' }, c.k.el, out)
    return (ctls[key] = c)
  }
  ctl('gain', 'volume', 'volume', fmtDb, (v) => deps.setGain(id, v), (v) => v, (p) => p, 1)
  ctl('speed', 'speed', 'playback speed (double-click: 1×)', fmtSpeed, (v) => deps.commit(id, v), toPos, toSpeed, toPos(1))
  ctl('sat', 'saturate', 'tape saturation', fmtPct, (v) => deps.setTape(id, { sat: v }))
  ctl('cutoff', 'filter', 'low-pass filter', fmtCutoff, (v) => deps.setTape(id, { cutoff: v }), toCutPos, toCutoff, 1)
  ctl('warble', 'warble', 'tape wow and flutter', fmtPct, (v) => deps.setTape(id, { warble: v }))

  const title = h('strong', { className: 'lp-name' }, `Loop ${lp.slot + 1}`)
  const head = h('div', { className: 'dev-head lp-head' }, power, title, h('span', { className: 'grow' }), h('span', { className: 'lp-region' }, draw, clear))
  const el = h('div', { className: 'dev looper lp-card' },
    head,
    h('div', { className: 'lp-knobs' }, ...Object.values(ctls).map((c) => c.el)))
  el.style.setProperty('--c', color)
  el.style.setProperty('--knob-c', color)
  cardMenu(el, head, title, 'delete looper', () => deps.remove(id), () => !deps.readOnly)

  let current = lp
  let lastArmed = false
  /** `auto`: the params a lane drives, keyed by `Looper` field; those show the lane's value and can't be dragged. */
  function update(l: Looper, armed: boolean, _rate: number, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = l
    lastArmed = armed
    const stat: Record<string, number> = { gain: l.gain ?? 1, speed: l.speed, sat: l.sat ?? 0, cutoff: l.cutoff ?? LOOP_CUTOFF_MAX, warble: l.warble ?? 0 }
    // a driven knob follows its lane (and is locked); a free one follows the doc unless it is being turned
    for (const [key, c] of Object.entries(ctls)) {
      const a = auto.get(key)
      const driven = !!a?.on && a.value != null
      c.label.classList.toggle('auto', !!a)
      c.el.classList.toggle('driven', driven)
      c.k.setDisabled(deps.readOnly || driven)
      if (driven || !c.active) {
        const v = driven ? a!.value! : stat[key]
        c.k.set(c.to(v))
        c.out.textContent = c.fmt(v)
      }
    }
    muted = l.muted ?? false
    power.setAttribute('aria-checked', String(!muted))
    el.classList.toggle('bypassed', muted)
    const has = l.length > 0
    clear.hidden = !has
    draw.classList.toggle('on', armed)
    draw.textContent = armed ? 'drag on the track…' : has ? 'redraw' : 'draw'
  }
  update(lp, false, 48000)
  /** Repaint with new automation values only (the playhead moved). */
  const refresh = (auto: Map<string, AutoInfo>) => update(current, lastArmed, 48000, auto)
  return { el, update, refresh }
}
