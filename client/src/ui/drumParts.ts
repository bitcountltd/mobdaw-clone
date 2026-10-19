// Pieces of the drum synth's panels (ui/devices.ts, ui/drumEditor.ts): its param groups, its knob names (two of which
// mean something different in each tone model) and a drawing of a hit's envelopes.
import { DEVICES, DRUM_MACROS, DRUM_SYNTH } from '@mobdaw/shared'

/** The drum synth's param groups (ids, shared/src/devices.ts). */
export const DRUM_GROUPS: { label: string; ids: number[] }[] = [
  { label: 'body', ids: [0, 1, 2, 3, 4, 5, 6, 7] },
  { label: 'noise', ids: [8, 9, 10, 11, 12, 13, 14] },
  { label: 'click', ids: [15, 16] },
  { label: 'out', ids: [17, 18, 19, 20, 21, 22] },
]

/** Knob names inside their group (the group label says whose level / decay it is). */
const NAMES: Record<number, string> = {
  7: 'level', 8: 'level', 9: 'filter', 10: 'freq', 11: 'res', 12: 'decay', 13: 'shape', 15: 'level', 16: 'tone',
}

/** A drum synth knob's name: `character` (5) and `timbre` (6) are named by what they do in `model` (param 0). */
export function drumKnobName(pid: number, model: number): string {
  if (pid === 5 || pid === 6) {
    const m = DRUM_MACROS[Math.round(model)] ?? DRUM_MACROS[0]
    return m[pid - 5]
  }
  return NAMES[pid] ?? DEVICES[DRUM_SYNTH].params.find((p) => p.id === pid)?.name ?? ''
}

const SVGNS = 'http://www.w3.org/2000/svg'
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** The noise envelope (0..1 of its level) at `t` ms, for its shape (param 13) and decay `nd` ms. */
export function noiseEnv(shape: number, nd: number, t: number): number {
  switch (Math.round(shape)) {
    case 1: return t <= nd ? 1 : Math.exp(-(t - nd) / 6) // gate: held, then a quick release
    case 2: { // clap: three quick bursts, then the tail
      if (t < 30) { const b = t % 10; return Math.exp(-b / 2.5) * (0.75 + 0.25 * Math.floor(t / 10) / 2) }
      return Math.exp((-5 * (t - 30)) / Math.max(1, nd))
    }
    case 3: return t <= nd ? (t / Math.max(1, nd)) ** 2 : Math.exp(-(t - nd) / 8) // swell: rises, then cut
    default: return Math.exp((-5 * t) / Math.max(1, nd))
  }
}

/** The span of time a drawing of the hit covers (ms): long enough for its longest part. */
export function drumSpan(val: (pid: number) => number): number {
  const body = val(7) > 0 ? val(4) : 0
  const noise = val(8) > 0 ? val(12) + (Math.round(val(13)) === 2 ? 30 : 0) + (Math.round(val(13)) % 2 === 1 ? 20 : 0) : 0
  return Math.min(5000, Math.max(30, Math.max(body, noise) * 1.08))
}

/**
 * A hit as a little drawing, in the style of the finnwave's envelope: the body's decay (filled, the track colour) with
 * its pitch bend as a dashed line over it, the noise envelope in its shape, and the click as a spike at the start.
 */
export function drumDrawing(W = 176, H = 44) {
  const bodyFill = svg('path', { class: 'dd-body-fill' })
  const body = svg('path', { class: 'dd-body' })
  const noise = svg('path', { class: 'dd-noise' })
  const bend = svg('path', { class: 'dd-bend' })
  const click = svg('path', { class: 'dd-click' })
  const span = svg('text', { class: 'dd-span', x: W - 3, y: 10, 'text-anchor': 'end' })
  const el = svg('svg', { class: 'ddraw', viewBox: `0 0 ${W} ${H}`, width: W, height: H })
  const tip = svg('title')
  tip.textContent = 'the hit: body (filled), noise, click; dashed: the pitch bend'
  el.append(tip, bodyFill, noise, body, bend, click, span)
  const N = 72
  const x0 = 3, x1 = W - 2, base = H - 1.5, top = 4
  const y = (v: number) => base - Math.max(0, Math.min(1, v)) * (base - top)
  const path = (f: (t: number) => number, T: number) => {
    let d = ''
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * T
      d += `${i ? 'L' : 'M'}${(x0 + (i / N) * (x1 - x0)).toFixed(1)} ${y(f(t)).toFixed(1)}`
    }
    return d
  }
  return {
    el,
    draw(val: (pid: number) => number) {
      const T = drumSpan(val)
      const bl = Math.min(1, val(7) / 1.2), nl = Math.min(1, val(8) / 1.2), cl = Math.min(1, val(15) / 1.2)
      const decay = Math.max(1, val(4))
      const b = path((t) => bl * Math.exp((-5 * t) / decay), T)
      body.setAttribute('d', b)
      bodyFill.setAttribute('d', `${b}L${x1} ${base}L${x0} ${base}Z`)
      noise.setAttribute('d', nl > 0.001 ? path((t) => nl * noiseEnv(val(13), Math.max(1, val(12)), t), T) : '')
      // the bend: from `bend` semitones off the pitch back to it, over the bend time (up is higher; ±1 octave at full)
      const st = val(2), bt = Math.max(1, val(3))
      bend.setAttribute('d', Math.abs(st) > 0.05 && bl > 0.001
        ? path((t) => 0.5 + Math.max(-0.5, Math.min(0.5, (st / 24) * 0.5 * Math.exp((-4 * t) / bt))), T)
        : '')
      const cw = 3.5
      click.setAttribute('d', cl > 0.001 ? `M${x0} ${base}L${x0 + 0.8} ${y(cl).toFixed(1)}L${x0 + cw} ${base}` : '')
      span.textContent = T >= 1000 ? `${(T / 1000).toFixed(1)} s` : `${Math.round(T)} ms`
    },
  }
}
