// Reusable studio controls: knob, fader, meter, toggle, icon button, segmented control, number field, tooltip.
// Vanilla TS; each returns its element plus a small API. Styles in controls.css (imported here).
import { paramToPos, paramToValue, type ParamDef } from '@mobdaw/shared'
import { fmtDb, gainToPos, posToGain } from '../ui/slider'
import { icon, type IconName } from './icons'
import './controls.css'

const SVGNS = 'http://www.w3.org/2000/svg'
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}
const div = (cls: string, ...kids: (Node | string)[]) => {
  const el = document.createElement('div')
  el.className = cls
  el.append(...kids)
  return el
}

// ---------------------------------------------------------------- floating readout (shared by knob, fader, numberField)

let readout: HTMLElement | null = null
/** Show the floating value readout centred above `anchor`. */
export function showReadout(anchor: Element, text: string) {
  if (!readout) readout = document.body.appendChild(div('value-tip'))
  const r = anchor.getBoundingClientRect()
  readout.textContent = text
  readout.style.left = `${r.left + r.width / 2}px`
  readout.style.top = `${r.top}px`
}
export function hideReadout() {
  readout?.remove()
  readout = null
}

// ---------------------------------------------------------------- value formatting

/** A parameter value as short text with its unit: `440 Hz`, `1.2 kHz`, `85 ms`, `1.40 s`, `0.30`. */
export function formatValue(v: number, unit?: string): string {
  const u = unit?.toLowerCase()
  if (u === 'hz') return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v.toFixed(v < 100 ? 1 : 0)} Hz`
  if (u === 'ms') return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`
  if (u === 's') return `${v.toFixed(2)} s`
  if (u === 'db') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  if (u === '%') return `${Math.round(v)}%`
  const a = Math.abs(v)
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
  return unit ? `${s} ${unit}` : s
}

// ---------------------------------------------------------------- drag helper

/**
 * Vertical (or horizontal) relative drag on `el` in position units (0..1 over `span` px). Shift = 10x finer.
 * Calls `move(delta)` with the change since the press, and `end(moved)` on release.
 */
function dragPos(el: HTMLElement, e: PointerEvent, span: number, axis: 'y' | 'x', move: (d: number) => void, end: (moved: boolean) => void) {
  e.preventDefault()
  el.setPointerCapture(e.pointerId)
  let last = axis === 'y' ? e.clientY : e.clientX
  let acc = 0
  let moved = false
  const onMove = (m: PointerEvent) => {
    const p = axis === 'y' ? m.clientY : m.clientX
    const d = axis === 'y' ? last - p : p - last
    last = p
    if (d) moved = true
    acc += (d / span) * (m.shiftKey ? 0.1 : 1)
    move(acc)
  }
  const onUp = () => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    end(moved)
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
}

/** Arrow / page / home / end keys as a position step; null for other keys. */
function keyStep(e: KeyboardEvent, fine: number, coarse: number): number | 'min' | 'max' | null {
  const f = e.shiftKey ? fine / 10 : fine
  switch (e.key) {
    case 'ArrowUp': case 'ArrowRight': return f
    case 'ArrowDown': case 'ArrowLeft': return -f
    case 'PageUp': return coarse
    case 'PageDown': return -coarse
    case 'Home': return 'min'
    case 'End': return 'max'
  }
  return null
}

// ---------------------------------------------------------------- knob

export type KnobOpts = {
  value: number
  min: number
  max: number
  def?: number
  scale?: 'lin' | 'log' | 'pow'
  label?: string
  unit?: string
  /** Text for the value readout (defaults to `formatValue(v, unit)`). */
  format?: (v: number) => string
  /** Draw the value arc from the centre (pan, detune). */
  bipolar?: boolean
  /** Diameter in px (default 36). */
  size?: number
  /** Arc colour; defaults to the accent (pass a track colour to tie a knob to its track). */
  color?: string
  title?: string
  disabled?: boolean
  onInput?(v: number): void
  onChange?(v: number): void
}
export type Knob = { el: HTMLElement; set(v: number): void; get(): number; setDisabled(d: boolean): void }

const ARC = 135 // degrees either side of 12 o'clock
const polar = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180
  return [20 + r * Math.sin(a), 20 - r * Math.cos(a)] as const
}
function arc(r: number, a0: number, a1: number) {
  if (Math.abs(a1 - a0) < 0.01) a1 = a0 + 0.01
  const [x0, y0] = polar(r, Math.min(a0, a1))
  const [x1, y1] = polar(r, Math.max(a0, a1))
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

/** A 270° rotary knob: drag up/down (shift = fine), wheel, double-click = default, arrow keys when focused. */
export function knob(o: KnobOpts): Knob {
  const p: ParamDef = { id: 0, name: o.label ?? '', min: o.min, max: o.max, def: o.def ?? o.min, scale: o.scale ?? 'lin', unit: o.unit }
  const fmt = o.format ?? ((v: number) => formatValue(v, o.unit))
  let value = o.value
  let disabled = !!o.disabled
  const size = o.size ?? 36

  const track = svgEl('path', { class: 'knob-track', d: arc(15, -ARC, ARC) })
  const fill = svgEl('path', { class: 'knob-fill' })
  const cap = svgEl('circle', { class: 'knob-cap', cx: 20, cy: 20, r: 11 })
  const pointer = svgEl('line', { class: 'knob-pointer', x1: 20, y1: 20, x2: 20, y2: 10.5 })
  const dot = svgEl('circle', { class: 'knob-def', r: 1 })
  const svg = svgEl('svg', { viewBox: '0 0 40 40', width: size, height: size, 'aria-hidden': 'true' })
  svg.append(track, fill, dot, cap, pointer)
  const el = div('knob')
  el.append(svg)
  if (o.label) el.append(div('knob-label', o.label))
  el.tabIndex = 0
  el.setAttribute('role', 'slider')
  if (o.label) el.setAttribute('aria-label', o.label)
  if (o.title) el.title = o.title
  if (o.color) el.style.setProperty('--knob-c', o.color)
  const [dx, dy] = polar(18.6, -ARC + 2 * ARC * paramToPos(p, p.def))
  dot.setAttribute('cx', dx.toFixed(2))
  dot.setAttribute('cy', dy.toFixed(2))

  const draw = () => {
    const pos = paramToPos(p, value)
    const a = -ARC + 2 * ARC * pos
    fill.setAttribute('d', arc(15, o.bipolar ? 0 : -ARC, a))
    pointer.setAttribute('transform', `rotate(${a.toFixed(1)} 20 20)`)
    el.setAttribute('aria-valuenow', String(value))
    el.setAttribute('aria-valuetext', fmt(value))
    el.setAttribute('aria-disabled', String(disabled))
    el.classList.toggle('disabled', disabled)
    el.tabIndex = disabled ? -1 : 0
  }
  const setPos = (pos: number, live: boolean) => {
    const v = paramToValue(p, clamp(pos, 0, 1))
    if (v === value) return
    value = v
    draw()
    if (active) showReadout(svg, fmt(value))
    if (live) o.onInput?.(value)
  }
  let active = false
  let hover = false
  const reveal = () => (active || hover ? showReadout(svg, fmt(value)) : hideReadout())

  el.addEventListener('pointerenter', () => ((hover = true), reveal()))
  el.addEventListener('pointerleave', () => ((hover = false), reveal()))
  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return
    el.focus({ preventScroll: true })
    const start = paramToPos(p, value)
    const before = value
    active = true
    el.classList.add('active')
    reveal()
    dragPos(el, e, 160, 'y', (d) => setPos(start + d, true), () => {
      active = false
      el.classList.remove('active')
      reveal()
      if (value !== before) o.onChange?.(value)
    })
  })
  el.addEventListener('dblclick', () => {
    if (disabled) return
    setPos(paramToPos(p, p.def), true)
    o.onChange?.(value)
  })
  let wheelTimer = 0
  el.addEventListener('wheel', (e) => {
    if (disabled) return
    e.preventDefault()
    const step = (e.shiftKey ? 0.004 : 0.02) * -Math.sign(e.deltaY || -e.deltaX)
    setPos(paramToPos(p, value) + step, true)
    showReadout(svg, fmt(value))
    clearTimeout(wheelTimer)
    wheelTimer = window.setTimeout(() => (o.onChange?.(value), reveal()), 350)
  }, { passive: false })
  el.addEventListener('keydown', (e) => {
    if (disabled) return
    const s = keyStep(e, 0.01, 0.1)
    if (s === null) return
    e.preventDefault()
    e.stopPropagation()
    setPos(s === 'min' ? 0 : s === 'max' ? 1 : paramToPos(p, value) + s, true)
    o.onChange?.(value)
  })
  el.addEventListener('blur', () => !hover && !active && hideReadout())

  el.setAttribute('aria-valuemin', String(o.min))
  el.setAttribute('aria-valuemax', String(o.max))
  draw()
  return {
    el,
    set(v) {
      if (active) return // the hand on the knob wins over remote updates
      value = clamp(v, o.min, o.max)
      draw()
    },
    get: () => value,
    setDisabled(d) {
      disabled = d
      draw()
    },
  }
}

// ---------------------------------------------------------------- fader

export type FaderOpts = {
  /** Linear gain, 0..2 (+6 dB). */
  value: number
  orientation?: 'vertical' | 'horizontal'
  /** Show the dB scale labels (vertical only; default true). */
  scale?: boolean
  /** Show the dB readout (default true). */
  readout?: boolean
  /** Colour of the cap's index line (e.g. the track colour). */
  color?: string
  title?: string
  disabled?: boolean
  onInput?(gain: number): void
  onChange?(gain: number): void
}
export type Fader = { el: HTMLElement; set(gain: number): void; get(): number; setDisabled(d: boolean): void }

/** The scale marks of a gain fader, in dB. */
export const FADER_MARKS = [6, 0, -6, -12, -24, -48]

/** A console fader for track gain: dB scale, dB readout, double-click = 0 dB, drag (shift = fine), wheel, keys. */
export function fader(o: FaderOpts): Fader {
  const vertical = (o.orientation ?? 'vertical') === 'vertical'
  let gain = o.value
  let disabled = !!o.disabled
  const cap = div('fader-cap')
  const fill = div('fader-fill')
  const slot = div('fader-slot', fill)
  const marks = div('fader-marks')
  for (const db of FADER_MARKS) {
    const m = div(db === 0 ? 'fader-mark unity' : 'fader-mark')
    m.style.setProperty('--p', String(gainToPos(10 ** (db / 20))))
    if (vertical && o.scale !== false) m.append(document.createElement('span'))
    m.lastElementChild?.append(db > 0 ? `+${db}` : String(db))
    marks.append(m)
  }
  const track = div('fader-track', marks, slot, cap)
  const out = document.createElement('output')
  out.className = 'fader-readout'
  const el = div(`fader ${vertical ? 'v' : 'h'}`, track)
  if (o.readout !== false) el.append(out)
  el.tabIndex = 0
  el.setAttribute('role', 'slider')
  el.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal')
  el.setAttribute('aria-label', o.title ?? 'gain')
  el.title = o.title ?? 'gain (double-click: 0 dB)'
  if (o.color) el.style.setProperty('--fader-c', o.color)

  const draw = () => {
    const pos = gainToPos(gain)
    el.style.setProperty('--pos', pos.toFixed(4))
    const db = fmtDb(gain).replace(' dB', '')
    out.textContent = db
    el.setAttribute('aria-valuenow', String(gain))
    el.setAttribute('aria-valuetext', fmtDb(gain))
    el.classList.toggle('disabled', disabled)
    el.classList.toggle('hot', gain > 1.0001)
    el.tabIndex = disabled ? -1 : 0
  }
  let active = false
  const setPos = (pos: number) => {
    const g = posToGain(clamp(pos, 0, 1))
    // a soft detent at unity so 0 dB is easy to hit by hand
    const snapped = Math.abs(20 * Math.log10(Math.max(g, 1e-6))) < 0.25 ? 1 : g
    if (snapped === gain) return
    gain = snapped
    draw()
    if (active) showReadout(cap, fmtDb(gain))
    o.onInput?.(gain)
  }
  const len = () => (vertical ? track.clientHeight : track.clientWidth) || 120
  track.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return
    el.focus({ preventScroll: true })
    const before = gain
    if (e.target !== cap) {
      // a press on the slot jumps the cap there, then drags from it
      const r = track.getBoundingClientRect()
      setPos(vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width)
    }
    const start = gainToPos(gain)
    active = true
    el.classList.add('active')
    showReadout(cap, fmtDb(gain))
    dragPos(track, e, len(), vertical ? 'y' : 'x', (d) => setPos(start + d), () => {
      active = false
      el.classList.remove('active')
      hideReadout()
      if (gain !== before) o.onChange?.(gain)
    })
  })
  el.addEventListener('dblclick', () => {
    if (disabled) return
    gain = 1
    draw()
    o.onInput?.(gain)
    o.onChange?.(gain)
  })
  let wheelTimer = 0
  el.addEventListener('wheel', (e) => {
    if (disabled) return
    e.preventDefault()
    setPos(gainToPos(gain) + (e.shiftKey ? 0.004 : 0.02) * -Math.sign(e.deltaY || -e.deltaX))
    showReadout(cap, fmtDb(gain))
    clearTimeout(wheelTimer)
    wheelTimer = window.setTimeout(() => (o.onChange?.(gain), hideReadout()), 350)
  }, { passive: false })
  el.addEventListener('keydown', (e) => {
    if (disabled) return
    const s = keyStep(e, 0.01, 0.1)
    if (s === null) return
    e.preventDefault()
    e.stopPropagation()
    setPos(s === 'min' ? 0 : s === 'max' ? 1 : gainToPos(gain) + s)
    o.onChange?.(gain)
  })
  draw()
  return {
    el,
    set(g) {
      if (active) return
      gain = clamp(g, 0, 2)
      draw()
    },
    get: () => gain,
    setDisabled(d) {
      disabled = d
      draw()
    },
  }
}

// ---------------------------------------------------------------- meter

export type MeterOpts = { orientation?: 'vertical' | 'horizontal'; stereo?: boolean; /** Draw LED-style segments (default true). */ segments?: boolean }
export type Meter = { el: HTMLElement; push(l: number, r?: number): void; reset(): void; destroy(): void }

/** The meter's dB range: -60 dBFS at the bottom, +6 at the top. */
const M_FLOOR = -60
const M_TOP = 6
const dbOf = (g: number) => (g <= 1e-6 ? -120 : 20 * Math.log10(g))
/** Meter position 0..1 of a level in dB (linear in dB, a little more room near the top). */
export const meterPos = (db: number) => clamp((db - M_FLOOR) / (M_TOP - M_FLOOR), 0, 1) ** 1.35

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/**
 * A peak meter on one canvas: smooth fall-back (about 20 dB/s), a peak-hold tick that waits 1.2 s, green to amber to
 * red above -3 dBFS, and a clip lamp that stays lit until clicked. It only redraws while something is moving.
 */
export function meter(o: MeterOpts = {}): Meter {
  const vertical = (o.orientation ?? 'vertical') === 'vertical'
  const n = o.stereo ? 2 : 1
  const canvas = document.createElement('canvas')
  const el = div(`meter-el ${vertical ? 'v' : 'h'}${o.stereo ? ' stereo' : ''}`, canvas)
  el.title = 'level (click to clear the clip lamp)'
  const level = new Float64Array(n).fill(M_FLOOR - 1) // dB shown
  const peak = new Float64Array(n).fill(M_FLOOR - 1)
  const peakAt = new Float64Array(n)
  let clipped = false
  let raf = 0
  let last = 0
  let w = 0, h = 0, dpr = 1
  let colors: { ok: string; accent: string; rec: string; off: string; hold: string } | null = null

  const resize = () => {
    dpr = devicePixelRatio || 1
    w = Math.max(1, Math.round(el.clientWidth * dpr))
    h = Math.max(1, Math.round(el.clientHeight * dpr))
    canvas.width = w
    canvas.height = h
    draw()
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
  ro?.observe(el)

  const colorAt = (db: number) => (db > -3 ? colors!.rec : db > -15 ? colors!.accent : colors!.ok)

  function draw() {
    const ctx = canvas.getContext('2d')
    if (!ctx || !w || !h) return
    colors ??= { ok: css('--ok', '#7cc489'), accent: css('--accent', '#f0b44c'), rec: css('--rec', '#ee5a52'), off: css('--line', '#33373d'), hold: css('--fg', '#ebe6dc') }
    ctx.clearRect(0, 0, w, h)
    const len = vertical ? h : w
    const thick = vertical ? w : h
    const gap = Math.max(1, Math.round(dpr))
    const lamp = Math.round(3 * dpr) // the clip lamp at the top / right end
    const run = len - lamp - gap
    const bar = (thick - gap * (n - 1)) / n
    const seg = o.segments === false ? 0 : Math.max(2, Math.round(3 * dpr))
    for (let c = 0; c < n; c++) {
      const across = Math.round(c * (bar + gap))
      const bw = Math.round((c + 1) * (bar + gap) - gap) - across
      const lit = Math.round(meterPos(level[c]) * run)
      const rect = (from: number, size: number) => vertical
        ? ctx.fillRect(across, h - from - size, bw, size)
        : ctx.fillRect(from, across, size, bw)
      // unlit track
      ctx.fillStyle = colors.off
      rect(0, run)
      if (seg) {
        for (let at = 0; at < lit; at += seg + gap) {
          const s = Math.min(seg, lit - at)
          ctx.fillStyle = colorAt(M_FLOOR + (M_TOP - M_FLOOR) * ((at + s) / run) ** (1 / 1.35))
          rect(at, s)
        }
      } else if (lit > 0) {
        for (const [db0, db1] of [[M_FLOOR, -15], [-15, -3], [-3, M_TOP]] as const) {
          const a = Math.round(meterPos(db0) * run), b = Math.min(lit, Math.round(meterPos(db1) * run))
          if (b > a) (ctx.fillStyle = colorAt((db0 + db1) / 2)), rect(a, b - a)
        }
      }
      // peak hold
      if (peak[c] > M_FLOOR) {
        ctx.fillStyle = peak[c] > -3 ? colors.rec : colors.hold
        rect(Math.min(run - gap, Math.round(meterPos(peak[c]) * run)), gap * 2 > run ? 1 : gap + (dpr > 1 ? 1 : 0))
      }
    }
    // clip lamp
    ctx.fillStyle = clipped ? colors.rec : colors.off
    vertical ? ctx.fillRect(0, 0, w, lamp) : ctx.fillRect(w - lamp, 0, lamp, h)
  }

  function frame(t: number) {
    raf = 0
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0
    last = t
    let moving = false
    for (let c = 0; c < n; c++) {
      if (level[c] > M_FLOOR - 1) {
        level[c] -= 20 * dt
        moving = true
      }
      if (peak[c] > M_FLOOR - 1 && t - peakAt[c] > 1200) {
        peak[c] -= 30 * dt
        moving = true
      }
    }
    draw()
    if (moving) raf = requestAnimationFrame(frame)
    else last = 0
  }
  const wake = () => {
    if (!raf) raf = requestAnimationFrame(frame)
  }

  el.addEventListener('click', () => {
    clipped = false
    draw()
  })

  return {
    el,
    push(l, r = l) {
      const now = performance.now()
      const v = n === 2 ? [l, r] : [Math.max(l, r)]
      for (let c = 0; c < n; c++) {
        const db = dbOf(v[c])
        if (db > level[c]) level[c] = db
        if (db >= peak[c]) (peak[c] = db), (peakAt[c] = now)
        if (v[c] >= 1) clipped = true
      }
      wake()
    },
    reset() {
      level.fill(M_FLOOR - 1)
      peak.fill(M_FLOOR - 1)
      clipped = false
      draw()
    },
    destroy() {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    },
  }
}

// ---------------------------------------------------------------- toggle, icon button, segmented

export type ToggleOpts = { on?: boolean; title?: string; tone?: 'accent' | 'rec'; className?: string; onChange?(on: boolean): void }
export type Toggle = { el: HTMLButtonElement; set(on: boolean): void; get(): boolean }

/** A latching button: quiet when off, lit (accent, or red for `tone: 'rec'`) when on. `content` is a label, an icon name or a node. */
export function toggle(content: string | Node | { icon: IconName }, o: ToggleOpts = {}): Toggle {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `toggle${o.className ? ' ' + o.className : ''}`
  if (typeof content === 'string') el.textContent = content
  else if (content instanceof Node) el.append(content)
  else (el.append(icon(content.icon)), el.classList.add('icon-btn'))
  if (o.tone === 'rec') el.dataset.tone = 'rec'
  if (o.title) (el.title = o.title), el.setAttribute('aria-label', o.title)
  let on = !!o.on
  const draw = () => {
    el.classList.toggle('on', on)
    el.setAttribute('aria-pressed', String(on))
  }
  el.addEventListener('click', () => {
    on = !on
    draw()
    o.onChange?.(on)
  })
  draw()
  return { el, set: (v) => ((on = v), draw()), get: () => on }
}

/** A square icon-only button. `title` names the action and its shortcut, e.g. "play / pause (space)". */
export function iconButton(name: IconName, title: string, onclick?: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `icon-btn${cls ? ' ' + cls : ''}`
  el.title = title
  el.setAttribute('aria-label', title)
  el.append(icon(name))
  if (onclick) el.addEventListener('click', onclick)
  return el
}

export type SegOption<T extends string> = T | { value: T; label?: string; icon?: IconName; title?: string }
export type Segmented<T extends string> = { el: HTMLElement; set(v: T): void; get(): T }

/** A row of mutually exclusive buttons (arrange / mix, grid sizes). */
export function segmented<T extends string>(options: SegOption<T>[], value: T, onChange?: (v: T) => void): Segmented<T> {
  const el = div('seg')
  el.setAttribute('role', 'radiogroup')
  let cur = value
  const btns = options.map((opt) => {
    const o = typeof opt === 'string' ? { value: opt, label: opt } : opt
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    if (o.icon) b.append(icon(o.icon))
    if (o.label) b.append(o.label)
    if (o.title) (b.title = o.title), b.setAttribute('aria-label', o.title)
    b.addEventListener('click', () => {
      if (cur === o.value) return
      cur = o.value
      draw()
      onChange?.(cur)
    })
    el.append(b)
    return [o.value, b] as const
  })
  const draw = () => {
    for (const [v, b] of btns) {
      b.classList.toggle('on', v === cur)
      b.setAttribute('aria-checked', String(v === cur))
      b.tabIndex = v === cur ? 0 : -1
    }
  }
  el.addEventListener('keydown', (e) => {
    const i = btns.findIndex(([v]) => v === cur)
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const [v, b] = btns[(i + d + btns.length) % btns.length]
    cur = v
    draw()
    b.focus()
    onChange?.(cur)
  })
  draw()
  return { el, set: (v) => ((cur = v), draw()), get: () => cur }
}

// ---------------------------------------------------------------- number field

export type NumberFieldOpts = {
  value: number
  min?: number
  max?: number
  step?: number
  /** Text shown when not editing (default: the number, with as many decimals as `step`). */
  format?: (v: number) => string
  /** Pixels of drag per step (default 4). */
  pxPerStep?: number
  title?: string
  width?: string
  onInput?(v: number): void
  onChange?(v: number): void
}
export type NumberField = { el: HTMLInputElement; set(v: number): void; get(): number }

/** A number you can drag sideways (or up/down) to scrub, or click to type. Enter commits, Escape reverts, arrows step. */
export function numberField(o: NumberFieldOpts): NumberField {
  const step = o.step ?? 1
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
  const fmt = o.format ?? ((v: number) => v.toFixed(decimals))
  const fix = (v: number) => clamp(Math.round(v / step) * step, o.min ?? -Infinity, o.max ?? Infinity)
  let value = fix(o.value)
  const el = document.createElement('input')
  el.className = 'numfield'
  el.inputMode = 'decimal'
  el.spellcheck = false
  el.autocomplete = 'off'
  if (o.title) el.title = o.title
  if (o.width) el.style.width = o.width
  const show = () => (el.value = fmt(value))
  const commit = (v: number) => {
    const n = fix(v)
    if (n !== value) {
      value = n
      o.onInput?.(value)
      o.onChange?.(value)
    }
    show()
  }
  let editing = false
  el.readOnly = true
  el.addEventListener('pointerdown', (e) => {
    if (editing || e.button !== 0) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX, y0 = e.clientY, start = value
    let scrubbing = false
    const px = o.pxPerStep ?? 4
    const move = (m: PointerEvent) => {
      const d = m.clientX - x0 - (m.clientY - y0)
      if (!scrubbing && Math.abs(d) < 3) return
      scrubbing = true
      el.classList.add('scrubbing')
      const n = fix(start + Math.round(d / px / (m.shiftKey ? 5 : 1)) * step)
      if (n !== value) (value = n), show(), o.onInput?.(value)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.classList.remove('scrubbing')
      if (scrubbing) {
        if (value !== start) o.onChange?.(value)
        return
      }
      // a click without a drag: type a value
      editing = true
      el.readOnly = false
      el.value = String(value)
      el.focus()
      el.select()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
  const stopEditing = (apply: boolean) => {
    if (!editing) return
    editing = false
    el.readOnly = true
    const n = Number(el.value.replace(',', '.').replace(/[^\d.+-eE]/g, ''))
    if (apply && el.value.trim() !== '' && Number.isFinite(n)) commit(n)
    else show()
  }
  el.addEventListener('keydown', (e) => {
    e.stopPropagation() // typing a value must not trigger studio shortcuts
    if (e.key === 'Enter') return stopEditing(true), el.blur()
    if (e.key === 'Escape') return stopEditing(false), el.blur()
    if (!editing) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        editing = true
        el.readOnly = false
        el.select()
        return
      }
      const s = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
      if (s) (e.preventDefault(), commit(value + s * step * (e.shiftKey ? 10 : 1)))
    }
  })
  el.addEventListener('blur', () => stopEditing(true))
  el.addEventListener('wheel', (e) => {
    if (editing || document.activeElement !== el) return
    e.preventDefault()
    commit(value - Math.sign(e.deltaY) * step)
  }, { passive: false })
  show()
  return { el, set: (v) => ((value = fix(v)), editing || show()), get: () => value }
}

// ---------------------------------------------------------------- tooltip

let tipEl: HTMLElement | null = null
let tipTimer = 0

/** A styled tooltip for `el` (replaces its native title): the action, and its shortcut as a key cap. */
export function tooltip(el: HTMLElement, text: string, shortcut?: string) {
  el.removeAttribute('title')
  if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', shortcut ? `${text} (${shortcut})` : text)
  el.dataset.tip = text
  if (shortcut) el.dataset.tipKey = shortcut
  if (el.dataset.tipBound) return
  el.dataset.tipBound = '1'
  const show = () => {
    hideTip()
    tipTimer = window.setTimeout(() => {
      if (!el.isConnected) return
      tipEl = div('tip', el.dataset.tip ?? '')
      if (el.dataset.tipKey) {
        const k = document.createElement('kbd')
        k.textContent = el.dataset.tipKey
        tipEl.append(k)
      }
      document.body.append(tipEl)
      const r = el.getBoundingClientRect()
      const t = tipEl.getBoundingClientRect()
      let x = r.left + r.width / 2 - t.width / 2
      x = clamp(x, 4, innerWidth - t.width - 4)
      const below = r.bottom + 6 + t.height < innerHeight
      tipEl.style.left = `${x}px`
      tipEl.style.top = `${below ? r.bottom + 6 : r.top - t.height - 6}px`
    }, 450)
  }
  el.addEventListener('pointerenter', show)
  el.addEventListener('focus', () => el.matches(':focus-visible') && show())
  for (const ev of ['pointerleave', 'pointerdown', 'blur', 'keydown'] as const) el.addEventListener(ev, hideTip)
}
export function hideTip() {
  clearTimeout(tipTimer)
  tipEl?.remove()
  tipEl = null
}
