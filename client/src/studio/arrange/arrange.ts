// The arrangement: one scroller holding the ruler (sticky on top), the track rows (headers sticky on the left) and the
// automation. It owns zoom anchoring (ctrl + wheel keeps the time under the pointer; the top bar's buttons keep the middle),
// following the playhead, zoom to fit, the musical grid under the lanes (grid.ts) and drops outside any lane.
import { applyDrop, readDragPayload } from '../drops'
import { clipLength, getClips, getLoop, getPads, getTracks, isForever, patternTicks, samplesPerBar } from '@mobdaw/shared'
import { h } from '../../dom'
import type { Studio } from '../studio'
import { HEADER, audioFiles, mountLanes } from './lanes'
import { mountLaneGrid } from './grid'
import { mountRuler } from './ruler'
import { mountTrackHeaders } from './tracks'
import './arrange.css'

export const ZOOM_MIN = 10, ZOOM_MAX = 800
/** Ask the arrangement to zoom so the whole song fits the visible lanes (the top bar, the status bar and Z send it). */
export const ZOOM_FIT = 'mobdaw:zoom-fit'

export function mountArrange(st: Studio) {
  const content = h('div', { className: 'content' })
  const scroll = h('div', { className: 'scroll' }, content)
  const el = h('section', { className: 'arrange' }, scroll)
  const ruler = mountRuler(st, scroll)
  const grid = mountLaneGrid(st, el)
  const headers = mountTrackHeaders(st)
  const lanes = mountLanes(st, { scroll }, headers)
  content.append(ruler.el, lanes.el)

  // Drops outside any lane start a new track.
  scroll.ondragover = (e) => e.preventDefault()
  scroll.ondrop = (e) => {
    e.preventDefault()
    if (st.readOnly) return
    const at = st.fromX(e.clientX - scroll.getBoundingClientRect().left - HEADER + scroll.scrollLeft)
    const p = readDragPayload(e)
    if (p) return void applyDrop(st, p, { at })
    void st.dropFiles(audioFiles(e.dataTransfer?.files), null, at)
  }

  // --- zoom: whoever changes `pps` may leave an anchor (a screen x); otherwise the middle of the visible lanes stays put
  let anchor: number | null = null
  let lastPps = st.ui.pps
  const timeAt = (clientX: number, pps: number) => (clientX - scroll.getBoundingClientRect().left - HEADER + scroll.scrollLeft) / pps
  function zoomed() {
    const r = scroll.getBoundingClientRect()
    const cx = anchor ?? r.left + HEADER + (r.width - HEADER) / 2
    anchor = null
    const t = timeAt(cx, lastPps)
    lastPps = st.ui.pps
    // (the lanes have redrawn at the new scale by now: they subscribed first)
    scroll.scrollLeft = HEADER + t * st.ui.pps - (cx - r.left)
  }
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    anchor = e.clientX
    st.setUi({ pps: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.ui.pps * Math.exp(-e.deltaY * 0.01))) })
  }, { passive: false })

  /** Keep the playhead in view: while playing it pages right when it runs off the edge; a jump back (rewind) follows too. */
  function follow(p: number) {
    const px = HEADER + st.x(p)
    const left = scroll.scrollLeft + HEADER, right = scroll.scrollLeft + scroll.clientWidth
    if (px < left) scroll.scrollLeft = Math.max(0, px - HEADER - 40)
    else if (st.ui.follow && st.playing && px > right - 20) scroll.scrollLeft = px - HEADER - 40
  }

  /** Where the song ends (samples): the last clip, region or loop end; looping-forever clips count one pattern. At least 4 bars. */
  function songEnd() {
    const scapes = new Set(getTracks(st.doc).filter((t) => t.kind === 'soundscape').map((t) => t.id))
    const ends = getClips(st.doc).filter((c) => !scapes.has(c.trackId)).map((c) => {
      if (!isForever(c)) return c.start + clipLength(c, st.rate)
      return c.start + (c.kind === 'midi' ? (patternTicks(c) / c.ppq) * (60 / c.bpm) * st.rate : clipLength(c, st.rate))
    })
    const loop = getLoop(st.doc)
    return Math.max(4 * samplesPerBar(st.tempo(), st.rate), ...ends, ...getPads(st.doc).map((p) => p.start + p.length), loop?.end ?? 0)
  }
  function zoomFit() {
    const w = scroll.clientWidth - HEADER - 24
    if (w <= 0) return
    const pps = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w / (songEnd() / st.rate)))
    anchor = scroll.getBoundingClientRect().left + HEADER // (keeps time 0 at the left edge, then scroll to it)
    st.setUi({ pps })
    scroll.scrollLeft = 0
  }
  addEventListener(ZOOM_FIT, zoomFit)

  /** The scroll area spans the whole timeline (the ruler and the lanes inside it are as wide). */
  const size = () => (content.style.width = `${HEADER + st.x(st.extent())}px`)
  const offs = [
    st.on('doc', size),
    st.on('ui', (p) => {
      if (!('pps' in p)) return
      size()
      if (st.ui.pps !== lastPps) zoomed()
    }),
    st.on('tick', follow),
  ]
  size()
  return {
    el,
    destroy() {
      offs.forEach((f) => f())
      removeEventListener(ZOOM_FIT, zoomFit)
      grid.destroy()
      lanes.destroy()
      headers.destroy()
      ruler.destroy()
    },
  }
}
