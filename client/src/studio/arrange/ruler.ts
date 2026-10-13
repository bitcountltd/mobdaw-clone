// The ruler above the lanes: second ticks (bars and beats come in Phase B), the playhead and collaborators' playheads.
// Click or drag on it to move the playhead. It sticks to the top of the arrangement's scroller.
import { h } from '../../dom'
import { fmt } from '../../ui/transport'
import type { Studio } from '../studio'

/** Second ticks with labels into `box` (rebuilt only when the extent or scale changes); `keep` stays after them. */
export function drawTicks(box: HTMLElement, totalSec: number, pps: number, keep: Node[] = []) {
  const step = pps >= 40 ? 1 : pps >= 15 ? 5 : 10
  const n = Math.floor(totalSec / step)
  const key = `${n}|${pps}`
  if (box.dataset.ticks === key) return
  box.dataset.ticks = key
  box.replaceChildren(...Array.from({ length: n + 1 }, (_, i) =>
    h('span', { className: 'tick', style: `left:${i * step * pps}px` }, fmt(i * step).replace(/\.0$/, ''))), ...keep)
}

export function mountRuler(st: Studio) {
  const body = h('div', { className: 'ruler-body' })
  const head = h('div', { className: 'playhead' })
  // The ruler is opaque and above the lanes' overlay, so it carries its own copies of the playhead lines.
  const heads = h('div', { className: 'overlay' }, head)
  const el = h('div', { className: 'ruler' }, h('div', { className: 'corner' }), body)

  const at = (clientX: number) => st.fromX(clientX - body.getBoundingClientRect().left)
  el.onpointerdown = (e) => {
    if (e.button !== 0) return
    st.seek(at(e.clientX))
    const move = (m: PointerEvent) => st.seek(at(m.clientX))
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  function draw() {
    const total = st.extent()
    body.style.width = `${st.x(total)}px`
    drawTicks(body, total / st.rate, st.ui.pps, [heads])
    for (const e of heads.querySelectorAll('.remote-head')) e.remove()
    for (const r of st.remote) {
      if (r.playhead == null) continue
      heads.append(h('div', { className: 'remote-head', style: `left:${st.x(r.playhead)}px;background:${r.user.color}` }))
    }
    drawHead(st.position())
  }
  const drawHead = (p: number) => (head.style.left = `${st.x(p)}px`)

  const offs = [
    st.on('doc', draw),
    st.on('ui', (p) => { if ('pps' in p) draw() }),
    st.on('tick', drawHead),
  ]
  draw()
  return { el, destroy: () => offs.forEach((f) => f()) }
}
