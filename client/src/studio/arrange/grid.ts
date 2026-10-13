// The musical grid of the arrangement: which bar / beat / sub-beat lines to draw at a zoom (pure, tested), the ruler's
// tick list for a visible window, and the lanes' grid. The lanes' grid is CSS, not nodes: arrange.ts sets
// `--lane-grid` (a stack of repeating gradients, one per line weight, plus the loop band) on the arrangement, and every
// `.lane-body` paints it as its background, under the clips. The gradients are spaced in exact (fractional) pixels from
// the same samples -> px mapping as the clips (`Studio.x`), so the lines sit under clip edges at every zoom.
import { getLoop, getMarkers, gridSamples, metaMap, samplesPerBar, samplesPerBeat, visibleGridBeats, type GridSize, type LoopRegion, type Tempo } from '@mobdaw/shared'
import type { Studio } from '../studio'
import { sectionMinLen, songEnd } from '../markers'
import { sectionBands } from './rulerMarkers'
import './grid.css'

/** Lines closer than this (px) are not drawn. */
export const MIN_LINE_PX = 12
/** Bar labels closer than this (px) skip bars. */
export const MIN_LABEL_PX = 34

export type GridLevels = {
  /** Spacing of the bar lines in beats (a bar, or several bars when zoomed far out). */
  bar: number
  /** Spacing of the beat lines in beats (0: not drawn). */
  beat: number
  /** Spacing of the sub-beat lines in beats (0: not drawn). */
  sub: number
  /** Label every `labelBars` bars (1, 2, 4, 8…). */
  labelBars: number
}

/**
 * What to draw at `pps` pixels per second: bar lines always (every few bars when zoomed out), beat lines once a beat
 * is MIN_LINE_PX wide, and sub-beat lines (down to 1/32) when zoomed in further. `sub` follows the snap grid when it
 * is finer than a beat (so the lines show where things will land), else the finest visible step.
 */
export function gridLevels(t: Tempo, pps: number, snap: GridSize = 0.25): GridLevels {
  const beatPx = (60 / t.bpm) * pps
  const barPx = beatPx * t.beatsPerBar
  const step = visibleGridBeats(t, pps, MIN_LINE_PX)
  const bar = Math.max(t.beatsPerBar, step)
  const beat = t.beatsPerBar > 1 && beatPx >= MIN_LINE_PX ? 1 : 0
  let sub = 0
  if (step < 1) {
    const want = typeof snap === 'number' && snap > 0 && snap < 1 ? snap : step
    sub = Math.max(want, step)
  }
  const labelBars = [1, 2, 4, 8, 16, 32, 64, 128].find((n) => n * barPx >= MIN_LABEL_PX) ?? 256
  return { bar, beat, sub, labelBars: Math.max(labelBars, bar / t.beatsPerBar) }
}

export type Tick = { px: number; kind: 'bar' | 'beat' | 'sub'; label?: string }

/**
 * The ruler's ticks between timeline px `x0` and `x1` (inclusive), at `pps` px/s: bar ticks (with a label on every
 * `labelBars`-th bar, counting from 1), beat ticks and sub ticks. Each position is computed from its index, not
 * accumulated, so there is no drift over a long song.
 */
export function rulerTicks(t: Tempo, pps: number, x0: number, x1: number, snap: GridSize = 0.25): Tick[] {
  const lv = gridLevels(t, pps, snap)
  const beatPx = (60 / t.bpm) * pps
  const finest = lv.sub || lv.beat || lv.bar
  const stepPx = finest * beatPx
  const out: Tick[] = []
  const i0 = Math.max(0, Math.floor(x0 / stepPx)), i1 = Math.ceil(x1 / stepPx)
  for (let i = i0; i <= i1; i++) {
    const beats = i * finest
    const px = beats * beatPx
    if (isWhole(beats / lv.bar)) {
      const barNo = Math.round(beats / t.beatsPerBar)
      out.push({ px, kind: 'bar', ...(isWhole(barNo / lv.labelBars) ? { label: String(barNo + 1) } : {}) })
    } else if (lv.beat && isWhole(beats / lv.beat)) out.push({ px, kind: 'beat' })
    else out.push({ px, kind: 'sub' })
  }
  return out
}
const isWhole = (v: number) => Math.abs(v - Math.round(v)) < 1e-6

/** A song section under the lanes: every other one (`alt`) a shade lighter, a coloured marker's tinted. */
export type SectionBand = { start: number; end: number; alt: boolean; color: string | null }

/** The CSS background layers for the lanes (bar lines on top, then the loop band, then the sections), in px from timeline 0. */
export function laneGridCss(t: Tempo, rate: number, pps: number, snap: GridSize, loop: LoopRegion | null, sections: SectionBand[] = []): string {
  const lv = gridLevels(t, pps, snap)
  const beatPx = (60 / t.bpm) * pps
  const px = (n: number) => `${+n.toFixed(4)}px`
  const lines = (beats: number, color: string) =>
    `repeating-linear-gradient(to right, ${color} 0 1px, transparent 1px ${px(beats * beatPx)})`
  const layers = [lines(lv.bar, 'var(--grid-bar)')]
  if (lv.beat) layers.push(lines(lv.beat, 'var(--grid-beat)'))
  if (lv.sub) layers.push(lines(lv.sub, 'var(--grid-sub)'))
  if (loop) {
    const a = (loop.start / rate) * pps, b = (loop.end / rate) * pps
    const c = loop.on ? 'var(--loop-band)' : 'var(--loop-band-off)'
    layers.push(`linear-gradient(to right, transparent ${px(a)}, ${c} ${px(a)} ${px(b)}, transparent ${px(b)})`)
  }
  // the sections: one gradient with hard stops; plain sections leave the lane as it is, every other one is lifted a hair
  const shaded = sections.filter((s) => s.alt || s.color)
  if (shaded.length) {
    const stops = shaded.map((s) => {
      const a = px((s.start / rate) * pps), b = px((s.end / rate) * pps)
      const c = s.color ? `color-mix(in srgb, ${s.color} ${s.alt ? 6 : 4}%, transparent)` : 'var(--sect-band)'
      return `transparent ${a}, ${c} ${a} ${b}, transparent ${b}`
    })
    layers.push(`linear-gradient(to right, ${stops.join(', ')})`)
  }
  return layers.join(', ')
}

/** Samples per snap step (the grid's), falling back to a beat when the grid is off. */
export const stepSamples = (g: GridSize, t: Tempo, rate: number) => gridSamples(g, t, rate) || samplesPerBeat(t.bpm, rate)
export { samplesPerBar }

/**
 * Keep the lanes' grid background in step with the tempo, meter, loop, zoom and snap grid. It is one rule in a <style> of
 * its own (not a custom property on the arrangement, which every clip and note mark inherits: changing that restyled
 * all of them on each zoom step), so only the lane bodies are restyled.
 */
export function mountLaneGrid(st: Studio, host: HTMLElement) {
  let last = ''
  const style = document.createElement('style')
  style.dataset.laneGrid = ''
  document.head.append(style)
  void host
  const draw = () => {
    const css = laneGridCss(st.tempo(), st.rate, st.ui.pps, st.ui.grid, getLoop(st.doc), sectionBands(getMarkers(st.doc), songEnd(st), sectionMinLen(st)))
    if (css === last) return
    last = css
    style.textContent = `.studio .arrange .lane-row > .lane-body:not(.master-body):not(.src-body) { background-image: ${css || 'none'}; }`
  }
  const meta = metaMap(st.doc)
  meta.observe(draw)
  const offs = [st.on('ui', (p) => { if ('pps' in p || 'grid' in p) draw() }), st.on('doc', draw)]
  draw()
  return { draw, destroy: () => { meta.unobserve(draw); offs.forEach((f) => f()); style.remove() } }
}
