// The ruler above the lanes: bars and beats (from the project tempo and meter), the loop region (cycle) and the
// playheads. It sticks to the top of the arrangement's scroller.
//   upper strip   drag on empty ruler: draw a loop region (snapped; alt = free). Drag the brace's ends to resize it, its
//                 body to move it. Double-click: loop on / off. Right-click anywhere: the loop menu.
//   lower part    click or drag: move the playhead.
// The ticks are drawn on one canvas the size of the visible window (redrawn on scroll); the loop brace and the
// playheads are a few positioned elements.
import { clipLength, getClips, getLoop, loopAround, loopBetween, metaMap, setLoop, toggledLoop, type LoopRegion } from '@mobdaw/shared'
import { h } from '../../dom'
import { fmt } from '../../ui/transport'
import { popover } from '../../ui/popover'
import type { Studio } from '../studio'
import { rulerTicks, stepSamples } from './grid'
import { HEADER } from './lanes'

/** Second ticks with labels into `box` (rebuilt only when the extent or scale changes); `keep` stays after them. (Soundscape source lanes, which run in seconds.) */
export function drawTicks(box: HTMLElement, totalSec: number, pps: number, keep: Node[] = []) {
  const step = pps >= 40 ? 1 : pps >= 15 ? 5 : 10
  const n = Math.floor(totalSec / step)
  const key = `${n}|${pps}`
  if (box.dataset.ticks === key) return
  box.dataset.ticks = key
  box.replaceChildren(...Array.from({ length: n + 1 }, (_, i) =>
    h('span', { className: 'tick', style: `left:${i * step * pps}px` }, fmt(i * step).replace(/\.0$/, ''))), ...keep)
}

/** Height of the loop strip at the top of the ruler (px); keep in step with grid.css. */
export const STRIP = 11

/** The span of the selected clips (samples), or null. */
export function selectionRange(st: Studio): { start: number; end: number } | null {
  const sel = new Set(st.ui.selection)
  const clips = getClips(st.doc).filter((c) => sel.has(c.id))
  if (!clips.length) return null
  return { start: Math.min(...clips.map((c) => c.start)), end: Math.max(...clips.map((c) => c.start + clipLength(c, st.rate))) }
}

/** L: loop on / off; with no region yet, one over the selection or the 4 bars around the playhead. */
export function toggleLoop(st: Studio) {
  if (st.readOnly) return
  const t = st.tempo()
  setLoop(st.doc, toggledLoop(getLoop(st.doc), st.position(), t, st.rate, selectionRange(st), stepSamples(st.ui.grid, t, st.rate)))
}

export function mountRuler(st: Studio, scroll: HTMLElement) {
  const { doc } = st
  const canvas = h('canvas', { className: 'rl-canvas' })
  const brace = h('div', { className: 'rl-brace', 'data-hint': 'loop region: drag to move it, drag an end to resize, double-click: on / off' })
  const hl = h('div', { className: 'rl-handle l', 'data-hint': 'drag: move the loop start' })
  const hr = h('div', { className: 'rl-handle r', 'data-hint': 'drag: move the loop end' })
  const loopEl = h('div', { className: 'rl-loop', hidden: true }, brace, hl, hr)
  const head = h('div', { className: 'playhead' })
  // The ruler is opaque and above the lanes' overlay, so it carries its own copies of the playhead lines.
  const heads = h('div', { className: 'overlay' }, head)
  const strip = h('div', { className: 'rl-strip', 'data-hint': 'drag: draw a loop region · double-click: loop on / off · right-click: loop menu' })
  const body = h('div', { className: 'ruler-body', 'data-hint': 'click or drag: move the playhead' }, canvas, strip, loopEl, heads)
  const el = h('div', { className: 'ruler bb' }, h('div', { className: 'corner' }), body)

  const at = (clientX: number) => st.fromX(clientX - body.getBoundingClientRect().left)
  const drag = (e: PointerEvent, move: (m: PointerEvent) => void, up?: () => void) => {
    e.preventDefault()
    const done = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', done)
      removeEventListener('pointercancel', done)
      el.classList.remove('dragging')
      up?.()
    }
    el.classList.add('dragging')
    addEventListener('pointermove', move)
    addEventListener('pointerup', done)
    addEventListener('pointercancel', done)
  }
  const minLen = () => stepSamples(st.ui.grid, st.tempo(), st.rate)
  const write = (l: LoopRegion | null) => setLoop(doc, l)

  el.onpointerdown = (e) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const loop = getLoop(doc)
    const y = e.clientY - body.getBoundingClientRect().top
    if (!st.readOnly && loop && (t === hl || t === hr)) {
      // resize from one end; dragging past the other end swaps them
      const fixed = t === hl ? loop.end : loop.start
      return drag(e, (m) => write(loopBetween(fixed, st.snap(at(m.clientX), m), minLen(), loop.on)))
    }
    if (!st.readOnly && loop && t === brace) {
      const from = at(e.clientX), len = loop.end - loop.start
      return drag(e, (m) => {
        const start = Math.max(0, st.snap(loop.start + at(m.clientX) - from, m))
        write({ start, end: start + len, on: loop.on })
      })
    }
    if (!st.readOnly && y < STRIP + 1) {
      // draw a new region (it appears once the pointer has moved a little)
      const x0 = e.clientX, a = st.snap(at(e.clientX), e)
      let drawn = false
      return drag(e, (m) => {
        if (!drawn && Math.abs(m.clientX - x0) < 4) return
        drawn = true
        write(loopBetween(a, st.snap(at(m.clientX), m), minLen(), true))
      })
    }
    st.seek(at(e.clientX))
    drag(e, (m) => st.seek(at(m.clientX)))
  }
  el.ondblclick = (e) => {
    if (st.readOnly) return
    const y = e.clientY - body.getBoundingClientRect().top
    const loop = getLoop(doc)
    if (loop && (e.target === brace || e.target === hl || e.target === hr || y < STRIP + 1)) write({ ...loop, on: !loop.on })
    else if (!loop && y < STRIP + 1) write(loopAround(at(e.clientX), st.tempo(), st.rate))
  }
  el.oncontextmenu = (e) => {
    e.preventDefault()
    if (st.readOnly) return
    const loop = getLoop(doc)
    const sel = selectionRange(st)
    const t = st.tempo()
    const step = stepSamples(st.ui.grid, t, st.rate)
    const here = at(e.clientX)
    popover(el, [
      { label: 'loop selection', icon: 'loop', disabled: !sel, run: () => write(toggledLoop(null, 0, t, st.rate, sel, step)) },
      { label: 'loop these 4 bars', run: () => write(loopAround(here, t, st.rate)) },
      'sep',
      { label: loop?.on ? 'loop off' : 'loop on', hint: 'L', disabled: !loop, run: () => loop && write({ ...loop, on: !loop.on }) },
      { label: 'clear loop', disabled: !loop, run: () => write(null) },
    ], [e.clientX, e.clientY])
  }

  // --- drawing
  let colors: Record<string, string> | null = null
  const css = (n: string) => getComputedStyle(el).getPropertyValue(n).trim()
  function drawCanvas() {
    // the body starts after the header column; the visible part of it is [scrollLeft, scrollLeft + clientWidth - HEADER]
    const off = Math.max(0, scroll.scrollLeft)
    const visW = Math.max(1, Math.min(body.offsetWidth - off, scroll.clientWidth - HEADER))
    const hgt = el.clientHeight || 30
    const dpr = devicePixelRatio || 1
    canvas.style.left = `${off}px`
    canvas.style.width = `${visW}px`
    if (canvas.width !== Math.round(visW * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(visW * dpr)
      canvas.height = Math.round(hgt * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    colors ??= { bar: css('--rl-bar') || 'rgba(235,230,220,.28)', beat: css('--rl-beat') || 'rgba(235,230,220,.16)', sub: css('--rl-sub') || 'rgba(235,230,220,.08)', label: css('--dim') || '#8f8b84', one: css('--fg') || '#ebe6dc', font: css('--font-ui') }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, visW, hgt)
    ctx.font = `500 11px ${colors.font}`
    ctx.textBaseline = 'alphabetic'
    const ticks = rulerTicks(st.tempo(), st.ui.pps, off - 40, off + visW, st.ui.grid)
    for (const tk of ticks) {
      const x = Math.round(tk.px - off) + 0.5
      const top = tk.kind === 'bar' ? STRIP + 1 : tk.kind === 'beat' ? hgt - 6 : hgt - 3
      ctx.fillStyle = colors[tk.kind]
      ctx.fillRect(x - 0.5, top, 1, hgt - top)
      if (tk.label) {
        ctx.fillStyle = tk.label === '1' ? colors.one : colors.label
        ctx.fillText(tk.label, x + 3.5, hgt - 7)
      }
    }
  }
  function drawLoop() {
    const loop = getLoop(doc)
    loopEl.hidden = !loop
    if (!loop) return
    loopEl.classList.toggle('on', loop.on)
    loopEl.style.left = `${st.x(loop.start)}px`
    loopEl.style.width = `${Math.max(2, st.x(loop.end) - st.x(loop.start))}px`
  }
  function draw() {
    const total = st.extent()
    body.style.width = `${st.x(total)}px`
    for (const e of heads.querySelectorAll('.remote-head')) e.remove()
    for (const r of st.remote) {
      if (r.playhead == null) continue
      heads.append(h('div', { className: 'remote-head', style: `left:${st.x(r.playhead)}px;background:${r.user.color}` }))
    }
    drawLoop()
    drawCanvas()
    drawHead(st.position())
  }
  const drawHead = (p: number) => (head.style.left = `${st.x(p)}px`)
  let raf = 0
  const soon = () => { if (!raf) raf = requestAnimationFrame(() => ((raf = 0), drawCanvas())) }
  const onMeta = () => { drawLoop(); soon() }

  const meta = metaMap(doc)
  meta.observe(onMeta)
  scroll.addEventListener('scroll', soon, { passive: true })
  addEventListener('resize', soon)
  const offs = [
    st.on('doc', draw),
    st.on('ui', (p) => { if ('pps' in p || 'grid' in p || 'browserOpen' in p) draw() }),
    st.on('tick', drawHead),
  ]
  draw()
  requestAnimationFrame(draw) // (once laid out: the canvas needs the scroller's width)
  return {
    el,
    destroy() {
      offs.forEach((f) => f())
      meta.unobserve(onMeta)
      scroll.removeEventListener('scroll', soon)
      removeEventListener('resize', soon)
      cancelAnimationFrame(raf)
    },
  }
}
