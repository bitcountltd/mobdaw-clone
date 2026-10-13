// The ruler's marker lane (above the loop strip): a small flag per song marker with its name, and its section as a
// faint band out to the next marker (the last one to the song's end), every other one a shade lighter.
//   flag          click: go there · drag: move it (to bars; shift = the snap grid, alt = free) · double-click: rename it
//                 in place · right-click: rename, loop this section, colour, delete
//   empty lane    double-click: add a marker there (on the bar)
// ruler.ts owns the element's pointer handlers and asks this lane first.
import {
  TRACK_COLORS, deleteMarker, sectionRange, formatBarsBeats, getMarkers, sectionIndexAt, snapToGrid, updateMarker, type Marker,
} from '@mobdaw/shared'
import { h } from '../../dom'
import { popover } from '../../ui/popover'
import { insertMarker, loopSection, markerKeys, markerPos, sectionMinLen, songEnd } from '../markers'
import type { Studio } from '../studio'
import './ruler-markers.css'

/** Height of the marker lane at the top of the ruler (px); keep in step with ruler-markers.css. */
export const MARKS = 17

const hint = (m: Marker) => `${m.name}: click to go there · drag to move (shift: grid, alt: free) · double-click to rename · right-click for more`

/** The sections the markers make, in timeline samples (for the bands here and under the lanes). */
export function sectionBands(markers: Marker[], end: number, minLen = 1) {
  return markers.map((m, i) => {
    const { start, end: e } = sectionRange(markers, i, end, minLen)
    return { id: m.id, start, end: e, alt: i % 2 === 1, color: m.color != null ? TRACK_COLORS[m.color % TRACK_COLORS.length] : null }
  })
}

export function mountMarkerLane(st: Studio, ruler: HTMLElement, body: HTMLElement) {
  const { doc } = st
  const bands = h('div', { className: 'rl-sections' })
  const flags = h('div', { className: 'rl-flags' })
  const el = h('div', { className: 'rl-marks', 'data-hint': st.readOnly ? 'song markers' : 'markers: double-click to add one here (I: at the playhead) · [ / ]: previous / next' }, bands, flags)
  let list: Marker[] = []
  const flagEls = new Map<string, HTMLElement>()
  let cur = -2
  let renaming: { id: string; input: HTMLInputElement; outside: (e: PointerEvent) => void } | null = null

  const at = (clientX: number) => st.fromX(clientX - body.getBoundingClientRect().left)

  function draw() {
    list = getMarkers(doc)
    const sections = sectionBands(list, songEnd(st), sectionMinLen(st))
    bands.replaceChildren(...sections.map((s) => {
      const b = h('div', { className: `rl-sect${s.alt ? ' alt' : ''}${s.color ? ' tinted' : ''}` })
      b.style.left = `${st.x(s.start)}px`
      b.style.width = `${Math.max(1, st.x(s.end) - st.x(s.start))}px`
      if (s.color) b.style.setProperty('--mc', s.color)
      return b
    }))
    const seen = new Set<string>()
    list.forEach((m, i) => {
      seen.add(m.id)
      let f = flagEls.get(m.id)
      if (!f) {
        f = h('div', { className: 'rl-flag', role: 'button', 'aria-label': `marker ${m.name}` }, h('span', { className: 'rl-flag-name' }))
        f.dataset.id = m.id
        flagEls.set(m.id, f)
        flags.append(f)
      }
      const s = sections[i]
      f.style.left = `${st.x(m.pos)}px`
      // the name never runs into the next flag: it ends a little before it (and shrinks to the pole when crowded)
      f.style.maxWidth = `${Math.max(9, st.x(s.end) - st.x(s.start) - 3)}px`
      f.classList.toggle('coloured', s.color != null)
      if (s.color) f.style.setProperty('--mc', s.color)
      else f.style.removeProperty('--mc')
      const name = f.firstChild as HTMLElement
      if (name.textContent !== m.name) name.textContent = m.name
      f.dataset.hint = hint(m)
      f.setAttribute('aria-label', `marker ${m.name}`)
    })
    for (const [id, f] of flagEls) if (!seen.has(id)) (f.remove(), flagEls.delete(id))
    if (renaming) placeRename()
    cur = -2
    tick(st.position())
  }

  /** Light the flag of the section the playhead is in. */
  function tick(p: number) {
    const i = sectionIndexAt(list, p)
    if (i === cur) return
    cur = i
    list.forEach((m, k) => flagEls.get(m.id)?.classList.toggle('cur', k === i))
  }

  // --- rename in place
  function placeRename() {
    const m = list.find((x) => x.id === renaming!.id)
    if (!m) return endRename(false)
    renaming!.input.style.left = `${st.x(m.pos)}px`
  }
  function startRename(id: string) {
    if (st.readOnly) return
    endRename(true)
    draw()
    const m = list.find((x) => x.id === id)
    if (!m) return
    const input = h('input', { className: 'rl-rename', type: 'text', value: m.name, maxLength: 40, spellcheck: false, 'aria-label': 'marker name' })
    const stop = (e: Event) => e.stopPropagation()
    input.addEventListener('pointerdown', stop)
    input.addEventListener('dblclick', stop)
    input.addEventListener('contextmenu', stop)
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') endRename(true)
      else if (e.key === 'Escape') endRename(false)
    })
    input.addEventListener('blur', () => endRename(true))
    // the lanes and the ruler preventDefault their pointerdowns (so the input never blurs): any press outside it
    // commits the name, seen in the capture phase before those handlers run
    const outside = (e: PointerEvent) => {
      if (e.target !== input) endRename(true)
    }
    document.addEventListener('pointerdown', outside, true)
    renaming = { id, input, outside }
    flagEls.get(id)?.classList.add('renaming')
    el.append(input)
    placeRename()
    input.focus()
    input.select()
  }
  function endRename(commit: boolean) {
    const r = renaming
    if (!r) return
    renaming = null
    document.removeEventListener('pointerdown', r.outside, true)
    flagEls.get(r.id)?.classList.remove('renaming')
    const name = r.input.value
    r.input.remove()
    if (commit && name.trim()) {
      st.undo.stopCapturing()
      updateMarker(doc, r.id, { name })
      st.undo.stopCapturing()
    }
  }

  /** Add a marker at `pos` (on the bar unless `free`) and name it in place when stopped. */
  function add(pos: number, free = false) {
    const r = insertMarker(st, pos, free)
    if (!r) return
    if (!r.added) {
      st.status('there is a marker there already')
      return startRename(r.id)
    }
    draw()
    const m = list.find((x) => x.id === r.id)
    if (st.playing) st.status(`marker ${m?.name ?? ''} at ${formatBarsBeats(m?.pos ?? 0, st.tempo(), st.rate)} · double-click it to rename`)
    else startRename(r.id)
  }

  const flagOf = (e: Event) => (e.target as HTMLElement).closest?.('.rl-flag') as HTMLElement | null
  const markerOf = (f: HTMLElement) => list.find((m) => m.id === f.dataset.id) ?? null
  const inLane = (e: MouseEvent) => e.clientY - body.getBoundingClientRect().top < MARKS

  /** A press on a flag: click = go there, drag = move it. True when it was the lane's. */
  function pointerdown(e: PointerEvent): boolean {
    const f = flagOf(e)
    const m = f && markerOf(f)
    if (!f || !m) return false
    e.preventDefault()
    if (st.readOnly) return (st.seek(m.pos), true)
    const x0 = e.clientX, from = at(e.clientX)
    let moved = false
    st.undo.stopCapturing() // one drag, one undo step
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return
      if (!moved) (moved = true, ruler.classList.add('dragging'), f.classList.add('moving'))
      const want = m.pos + at(ev.clientX) - from
      const pos = ev.altKey || ev.ctrlKey ? markerPos(st, want, true)
        : ev.shiftKey && st.ui.grid ? snapToGrid(want, st.ui.grid, st.tempo(), st.rate)
        : markerPos(st, want)
      updateMarker(doc, m.id, { pos })
      st.status(`${m.name} → ${formatBarsBeats(pos, st.tempo(), st.rate)}`)
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      ruler.classList.remove('dragging')
      f.classList.remove('moving')
      st.undo.stopCapturing()
      if (!moved) st.seek(m.pos)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
    return true
  }

  function dblclick(e: MouseEvent): boolean {
    const f = flagOf(e)
    if (f) return (startRename(f.dataset.id!), true)
    if (!inLane(e)) return false
    add(at(e.clientX), e.altKey)
    return true
  }

  function contextmenu(e: MouseEvent): boolean {
    const f = flagOf(e)
    const m = f && markerOf(f)
    if (!f || !m) return false
    const once = (fn: () => void) => () => { st.undo.stopCapturing(); fn(); st.undo.stopCapturing() }
    const close = popover(f, [
      { label: 'rename', hint: 'double-click', run: () => startRename(m.id) },
      { label: 'loop this section', icon: 'loop', run: () => loopSection(st, m.id) },
      'sep',
      { label: 'delete marker', icon: 'trash', danger: true, run: once(() => { deleteMarker(doc, m.id); st.status(`deleted marker ${m.name}`) }) },
    ], [e.clientX, e.clientY])
    // a row of colour swatches above the delete entry (the cassette-label hues, or none)
    const menu = [...document.querySelectorAll<HTMLElement>('body > .popover')].at(-1)
    const sep = menu?.querySelector('.sep')
    if (menu && sep) {
      const swatch = (c: number | null) => {
        const b = h('button', { className: `mk-swatch${(m.color ?? null) === c ? ' on' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String((m.color ?? null) === c), title: c == null ? 'no colour' : `colour ${c + 1}`,
          onclick: () => { close(); once(() => updateMarker(doc, m.id, { color: c }))() } })
        if (c != null) b.style.setProperty('--mc', TRACK_COLORS[c])
        return b
      }
      sep.before(h('div', { className: 'mk-colors', role: 'group', 'aria-label': 'marker colour' }, swatch(null), ...TRACK_COLORS.map((_, i) => swatch(i))))
    }
    return true
  }

  const keys = markerKeys(st, (id) => {
    draw()
    const m = list.find((x) => x.id === id)
    if (!st.playing) startRename(id)
    else if (m) st.status(`marker ${m.name} at ${formatBarsBeats(m.pos, st.tempo(), st.rate)}`)
  })

  return {
    el, keys, draw, tick, add, pointerdown, dblclick, contextmenu,
    destroy() { endRename(false) },
  }
}
