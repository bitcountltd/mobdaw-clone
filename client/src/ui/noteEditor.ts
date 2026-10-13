// The piano roll for one MIDI clip: a keyboard down the left, a pitch × time grid drawn in bars and beats, notes as
// rounded blocks in the track colour (velocity as their strength), and a velocity lane underneath.
//
//   click empty space       draw a note (and keep dragging to move it)     shift + drag   select with a box
//   drag a note             move the selection          drag its right edge   change the length
//   alt / ctrl held         no snapping                 double-click a note   delete it
//   keys (dock/clipEditor.ts registers them): q quantize, ↑/↓ transpose (shift: an octave), ←/→ move a step (shift: a
//   bar), ⌘/ctrl+a select all, delete, escape clears the selection
import { addNote, deleteNote, isLooping, patternTicks, updateClip, updateNote, type MidiClip, type Note } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import {
  floorTick, inMarquee, PITCH_MAX, PITCH_MIN, quantize, setVelocity, shift, snapTick, transpose, velocityAt, type NotePatch,
} from '../studio/dock/noteOps'
import { clamp, dragPointer } from './blocks'
import { noteName } from './noteName'
import { popover } from './popover'

const ROW_MIN = 6, ROW_MAX = 32
const EDGE = 6 // px at a note's right end that resize it
const KEYS_W = 52
const VEL_H = 64
const VEL_PAD = 8 // room above a full-velocity bar
const BLACK = new Set([1, 3, 6, 8, 10])
const isBlack = (p: number) => BLACK.has(((p % 12) + 12) % 12)

export type NoteEditorDeps = {
  doc: Y.Doc
  undo: Y.UndoManager
  readOnly: boolean
  /** The primary selected note (for the shortcuts outside the editor), or null. */
  selectNote(id: string | null): void
  /** Gate a key on the clip's track's instruments (on) or let it go: the sound while a note is drawn or dragged. */
  noteLive?(trackId: string, pitch: number, velocity: number, on: boolean): void
  /** The snap step in ticks for this clip (0: off). */
  step(c: MidiClip): number
  /** Beats in a bar (the project meter). */
  beatsPerBar(): number
  /** Say something in the status bar. */
  status?(text: string): void
}

export type View = { tc: string; pps: number; extent: number }

export function noteEditor(deps: NoteEditorDeps) {
  const { doc, undo, readOnly, noteLive } = deps
  let clip: MidiClip | null = null
  let notes = new Map<string, Note>()
  let centered = 0 // the height the view was last centred at
  let touched = false // the user has scrolled the pitches: leave them be
  let pxBeat = 48
  let row = 12 // px per pitch: ctrl/cmd + wheel zooms it
  let extent = 0
  let lastLen = 0 // the length of the last note drawn or resized (ticks); new notes take it
  const sel = new Set<string>()
  const els = new Map<string, HTMLElement>()
  const bars = new Map<string, HTMLElement>()

  // --- the keyboard
  const keys = h('div', { className: 'pr-keys' })
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    const k = h('div', { className: isBlack(p) ? 'pr-key black' : 'pr-key white' })
    k.dataset.pitch = String(p)
    if (p % 12 === 0) k.append(h('span', {}, noteName(p)))
    if (p % 12 === 0 || p % 12 === 5) k.classList.add('edge') // the line under a C or an F (between white keys)
    keys.append(k)
  }
  keys.onpointerdown = (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('.pr-key')
    if (!k || !clip || e.button !== 0) return
    e.preventDefault()
    const c = clip, p = Number(k.dataset.pitch)
    k.classList.add('down')
    noteLive?.(c.trackId, p, 0.8, true)
    const up = () => (k.classList.remove('down'), noteLive?.(c.trackId, p, 0.8, false), removeEventListener('pointerup', up), removeEventListener('pointercancel', up))
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  // --- the grid
  const rowsBg = h('div', { className: 'pr-rows' })
  const loopEnd = h('div', { className: 'ne-loop', hidden: true }) // the pattern's end: the notes past it are ignored
  const grip = h('i', { className: 'ne-grip', title: readOnly ? '' : 'drag to change the loop length' })
  loopEnd.append(grip)
  const marquee = h('div', { className: 'pr-marquee', hidden: true })
  const playhead = h('div', { className: 'pr-playhead', hidden: true })
  const hint = h('div', { className: 'pr-hint', hidden: true }, readOnly ? 'No notes in this clip.' : 'Click to draw a note. Shift-drag to select.')
  const grid = h('div', { className: 'pr-grid' }, rowsBg, loopEnd, marquee, playhead)
  const inner = h('div', { className: 'pr-inner' }, keys, grid)
  const scroll = h('div', { className: 'pr-scroll' }, inner)

  // --- the velocity lane
  const vel = h('div', { className: 'pr-vel' })
  const velScroll = h('div', { className: 'pr-vel-scroll' }, vel)
  const velLane = h('div', { className: 'pr-vel-lane' }, h('div', { className: 'pr-vel-label', title: 'drag the bars to set velocity (with notes selected, only those)' }, 'velocity'), velScroll)
  const el = h('div', { className: 'pr', tabIndex: 0 }, scroll, velLane, hint)
  el.style.setProperty('--keys-w', `${KEYS_W}px`)
  el.style.setProperty('--vel-h', `${VEL_H}px`)

  scroll.addEventListener('scroll', () => (velScroll.scrollLeft = scroll.scrollLeft), { passive: true })
  scroll.addEventListener('wheel', () => (touched = true), { passive: true })
  scroll.addEventListener('pointerdown', () => (touched = true))
  scroll.addEventListener('wheel', (e) => { // pinch (ctrl + wheel): zoom the pitch axis around the pointer
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return
    e.preventDefault()
    e.stopPropagation()
    const y = e.clientY - scroll.getBoundingClientRect().top
    const at = (scroll.scrollTop + y) / row
    row = clamp(row * Math.exp(-e.deltaY * 0.01), ROW_MIN, ROW_MAX)
    layoutRows()
    placeAll()
    scroll.scrollTop = at * row - y
  }, { passive: false })
  velLane.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) scroll.scrollLeft += e.deltaX || e.deltaY }, { passive: true })

  function layoutRows() {
    const n = PITCH_MAX - PITCH_MIN + 1
    el.style.setProperty('--row', `${row}px`)
    grid.style.height = keys.style.height = `${n * row}px`
    keys.classList.toggle('tight', row < 10)
  }
  layoutRows()

  const px = (ticks: number) => (ticks / clip!.ppq) * pxBeat
  const tickAt = (clientX: number) => ((clientX - grid.getBoundingClientRect().left) / pxBeat) * clip!.ppq
  const pitchAt = (clientY: number) => clamp(PITCH_MAX - Math.floor((clientY - grid.getBoundingClientRect().top) / row), PITCH_MIN, PITCH_MAX)
  const stepOf = (e?: { altKey: boolean; ctrlKey: boolean }) => (e && (e.altKey || e.ctrlKey) ? 0 : deps.step(clip!))
  const selected = () => [...sel].map((id) => notes.get(id)).filter((n): n is Note => !!n)

  function choose(ids: Iterable<string>, add = false) {
    if (!add) sel.clear()
    for (const id of ids) sel.add(id)
    deps.selectNote(sel.size ? [...sel].at(-1)! : null)
    paintSel()
  }
  function paintSel() {
    for (const [id, e] of els) e.classList.toggle('sel', sel.has(id))
    for (const [id, b] of bars) b.classList.toggle('sel', sel.has(id))
  }
  /** Write a batch of note patches as one undo step. */
  function apply(patches: NotePatch[] | null, what?: string) {
    if (!patches?.length) return false
    undo.stopCapturing()
    doc.transact(() => { for (const { id, ...p } of patches) updateNote(doc, id, p) })
    undo.stopCapturing()
    if (what) deps.status?.(what)
    return true
  }

  grid.onpointerdown = (e) => {
    e.stopPropagation()
    el.focus({ preventScroll: true })
    if (e.button !== 0 || !clip) return
    if ((e.target as HTMLElement).closest('.ne-grip')) return
    const c = clip
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note')
    if (!noteEl && e.shiftKey) return startMarquee(e)
    if (readOnly) {
      if (noteEl) choose([noteEl.dataset.id!], e.shiftKey)
      else choose([])
      return
    }
    e.preventDefault()
    undo.stopCapturing()
    let id: string
    let resize = false
    if (!noteEl) { // draw a note
      const step = stepOf(e) || c.ppq / 4
      const tick = Math.max(0, floorTick(tickAt(e.clientX), stepOf(e)))
      const durTicks = lastLen || Math.max(step, c.ppq / 4)
      id = addNote(doc, { clipId: c.id, tick, durTicks, pitch: pitchAt(e.clientY), velocity: 0.8 })
      notes.set(id, { id, clipId: c.id, tick, durTicks, pitch: pitchAt(e.clientY), velocity: 0.8 })
      choose([id])
      undo.stopCapturing()
    } else {
      id = noteEl.dataset.id!
      if (e.shiftKey) {
        if (sel.has(id)) { sel.delete(id); choose([...sel]); return }
        choose([id], true)
      } else if (!sel.has(id)) choose([id])
      resize = e.clientX > noteEl.getBoundingClientRect().right - EDGE
    }
    const lead = notes.get(id)
    if (!lead) return
    const group = selected().map((n) => ({ ...n }))
    const x0 = e.clientX, y0 = e.clientY
    let sounding = resize ? -1 : lead.pitch
    if (sounding >= 0) noteLive?.(c.trackId, sounding, lead.velocity, true)
    dragPointer(e, {
      onDrag: (m) => {
        const step = stepOf(m)
        const dRaw = ((m.clientX - x0) / pxBeat) * c.ppq
        if (resize) {
          const end = Math.max(lead.tick + (step || 1), snapTick(lead.tick + lead.durTicks + dRaw, step))
          const d = end - (lead.tick + lead.durTicks)
          doc.transact(() => { for (const n of group) updateNote(doc, n.id, { durTicks: Math.max(step || 1, n.durTicks + d) }) })
          lastLen = Math.max(step || 1, lead.durTicks + d)
          return
        }
        // the lead note snaps; the rest keep their places around it
        const first = Math.min(...group.map((n) => n.tick))
        const dTick = Math.max(-first, snapTick(lead.tick + dRaw, step) - lead.tick)
        let dP = -Math.round((m.clientY - y0) / row)
        const lo = Math.min(...group.map((n) => n.pitch)), hi = Math.max(...group.map((n) => n.pitch))
        dP = clamp(dP, PITCH_MIN - lo, PITCH_MAX - hi)
        doc.transact(() => { for (const n of group) updateNote(doc, n.id, { tick: n.tick + dTick, pitch: n.pitch + dP }) })
        const p = lead.pitch + dP
        if (p !== sounding) { // a new pitch retriggers
          noteLive?.(c.trackId, sounding, lead.velocity, false)
          sounding = p
          noteLive?.(c.trackId, sounding, lead.velocity, true)
        }
      },
      onEnd: () => {
        if (sounding >= 0) noteLive?.(c.trackId, sounding, lead.velocity, false)
        if (!resize && !lastLen) lastLen = lead.durTicks
        undo.stopCapturing()
      },
    })
  }
  grid.ondblclick = (e) => {
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note')
    if (readOnly || !noteEl) return
    sel.delete(noteEl.dataset.id!)
    deleteNote(doc, noteEl.dataset.id!)
    choose([...sel])
  }
  grid.oncontextmenu = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (readOnly || !clip) return
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note')
    if (noteEl && !sel.has(noteEl.dataset.id!)) choose([noteEl.dataset.id!])
    const n = sel.size
    popover(grid, [
      { label: n > 1 ? `delete ${n} notes` : 'delete note', run: removeSelected, disabled: !n, hint: 'del' },
      { label: n ? 'quantize selection' : 'quantize all notes', run: quantizeNotes, hint: 'q' },
      'sep',
      { label: 'select all', run: () => choose(notes.keys()), hint: '⌘A' },
    ], [e.clientX, e.clientY])
  }

  function startMarquee(e: PointerEvent) {
    e.preventDefault()
    const t0 = tickAt(e.clientX), p0 = pitchAt(e.clientY)
    const r = grid.getBoundingClientRect()
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top
    const before = new Set(sel)
    marquee.hidden = false
    const box = (m: PointerEvent) => {
      const x1 = m.clientX - r.left, y1 = m.clientY - r.top
      Object.assign(marquee.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` })
      const hit = inMarquee([...notes.values()], t0, tickAt(m.clientX), p0, pitchAt(m.clientY))
      choose([...before, ...hit.map((n) => n.id)])
    }
    box(e)
    dragPointer(e, { onDrag: box, onEnd: () => (marquee.hidden = true) })
  }

  grip.onpointerdown = (e) => {
    e.stopPropagation()
    if (readOnly || e.button !== 0 || !clip) return
    const c = clip
    const loop0 = patternTicks(c)
    e.preventDefault()
    undo.stopCapturing()
    dragPointer(e, {
      onDrag: (m) => {
        const step = stepOf(m) || c.ppq / 4
        const dTicks = ((m.clientX - e.clientX) / pxBeat) * c.ppq
        updateClip(doc, c.id, { loopTicks: clamp(snapTick(loop0 + dTicks, step), step, c.lengthTicks) })
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  // --- velocity lane: paint over the bars (the selection's only, when there is one)
  vel.onpointerdown = (e) => {
    e.stopPropagation()
    el.focus({ preventScroll: true })
    if (readOnly || e.button !== 0 || !clip) return
    e.preventDefault()
    undo.stopCapturing()
    const pool = () => (sel.size ? selected() : [...notes.values()])
    let lastX = e.clientX
    const paint = (m: PointerEvent) => {
      const r = vel.getBoundingClientRect()
      const a = Math.min(lastX, m.clientX) - r.left - 4, b = Math.max(lastX, m.clientX) - r.left + 4
      lastX = m.clientX
      const hit = pool().filter((n) => { const x = px(n.tick); return x >= a && x <= b })
      if (!hit.length) return
      const v = velocityAt(m.clientY - r.top - VEL_PAD, r.height - VEL_PAD)
      doc.transact(() => { for (const p of setVelocity(hit, v)) updateNote(doc, p.id, { velocity: p.velocity }) })
      deps.status?.(`velocity ${Math.round(v * 127)}`)
    }
    paint(e)
    dragPointer(e, { onDrag: paint, onEnd: () => undo.stopCapturing() })
  }

  // --- keys
  function quantizeNotes() {
    if (!clip) return
    const step = deps.step(clip) || clip.ppq / 4
    const list = sel.size ? selected() : [...notes.values()]
    if (!apply(quantize(list, step), `quantized ${list.length} note${list.length === 1 ? '' : 's'}`)) deps.status?.('already on the grid')
  }
  function removeSelected() {
    if (!sel.size) return
    undo.stopCapturing()
    doc.transact(() => { for (const id of sel) deleteNote(doc, id) })
    undo.stopCapturing()
    choose([])
  }
  /** The editor's commands, for the shortcuts (the clip tab registers them). */
  const commands = {
    hasSelection: () => sel.size > 0,
    selectAll: () => choose(notes.keys()),
    clearSelection: () => choose([]),
    quantize: quantizeNotes,
    remove: removeSelected,
    /** Move the selection up or down by `d` semitones (refused past the range), with a short blip of the new pitch. */
    transpose(d: number) {
      if (!clip || readOnly) return
      if (!apply(transpose(selected(), d))) return deps.status?.('out of range')
      const lead = notes.get([...sel].at(-1)!)
      if (lead && noteLive) {
        const p = clamp(lead.pitch + d, PITCH_MIN, PITCH_MAX), c = clip
        noteLive(c.trackId, p, lead.velocity, true)
        setTimeout(() => noteLive(c.trackId, p, lead.velocity, false), 160)
      }
    },
    /** Move the selection a grid step (or a bar) earlier (-1) or later (1). */
    nudge(dir: number, bar = false) {
      if (!clip || readOnly) return
      const step = bar ? clip.ppq * deps.beatsPerBar() : deps.step(clip) || clip.ppq / 4
      apply(shift(selected(), dir * step))
    },
  }

  // --- drawing
  function placeNote(e: HTMLElement, n: Note) {
    e.style.left = `${px(n.tick)}px`
    e.style.top = `${(PITCH_MAX - n.pitch) * row}px`
    e.style.width = `${Math.max(3, px(n.durTicks) - 1)}px`
    e.style.setProperty('--v', String(n.velocity))
    const label = px(n.durTicks) > 30 && row >= 13 ? noteName(n.pitch) : ''
    if (e.textContent !== label) e.textContent = label
  }
  function placeAll() {
    for (const [id, n] of notes) { const e = els.get(id); if (e) placeNote(e, n) }
  }

  /** `extent`: ticks to draw (a `forever` clip is drawn past its length). `selected`: the studio's note (null clears ours). */
  function update(c: MidiClip, list: Note[], selectedId: string | null, view: View) {
    clip = c
    extent = view.extent
    pxBeat = (view.pps * 60) / c.bpm
    const bpb = deps.beatsPerBar()
    const step = deps.step(c)
    el.style.setProperty('--tc', view.tc)
    el.style.setProperty('--beat', `${pxBeat}px`)
    el.style.setProperty('--bar', `${pxBeat * bpb}px`)
    const sub = step ? px(step) : 0
    el.style.setProperty('--sub', `${sub >= 7 && sub < pxBeat ? sub : pxBeat}px`)
    el.classList.toggle('no-beats', pxBeat < 6)
    notes = new Map(list.map((n) => [n.id, n]))
    for (const id of [...sel]) if (!notes.has(id)) sel.delete(id)
    if (selectedId == null && sel.size) sel.clear()
    else if (selectedId && !sel.has(selectedId) && notes.has(selectedId)) (sel.clear(), sel.add(selectedId))
    const w = px(extent)
    grid.style.width = `${w}px`
    vel.style.width = `${w + KEYS_W}px`
    const looping = isLooping(c)
    loopEnd.hidden = !looping
    if (looping) {
      loopEnd.style.left = `${px(c.loopTicks!)}px`
      loopEnd.style.width = `${Math.max(0, w - px(c.loopTicks!))}px`
    }
    for (const [id, e] of els) if (!notes.has(id)) { e.remove(); els.delete(id) }
    for (const [id, b] of bars) if (!notes.has(id)) { b.remove(); bars.delete(id) }
    for (const n of list) {
      let e = els.get(n.id)
      if (!e) {
        e = h('div', { className: 'note', 'data-id': n.id })
        els.set(n.id, e)
        grid.append(e)
      }
      placeNote(e, n)
      e.classList.toggle('ignored', looping && n.tick >= c.loopTicks!)
      let b = bars.get(n.id)
      if (!b) {
        b = h('i', { className: 'vbar' })
        bars.set(n.id, b)
        vel.append(b)
      }
      b.style.left = `${px(n.tick)}px`
      b.style.setProperty('--vv', String(n.velocity))
      b.classList.toggle('ignored', looping && n.tick >= c.loopTicks!)
    }
    paintSel()
    hint.hidden = list.length > 0
    // centre on the notes (C4 when empty), again while the dock settles, until the user scrolls
    if (!touched && el.isConnected && scroll.clientHeight > 40 && centered !== scroll.clientHeight) {
      const mid = list.length ? (Math.min(...list.map((n) => n.pitch)) + Math.max(...list.map((n) => n.pitch))) / 2 : 60
      scroll.scrollTop = (PITCH_MAX - mid) * row + row / 2 - scroll.clientHeight / 2
      centered = scroll.clientHeight
    }
  }
  /** The transport's place in the clip (ticks from its start), or null when it is elsewhere. */
  function setPlayhead(tick: number | null) {
    const on = tick != null && clip != null && tick >= 0 && tick < extent
    playhead.hidden = !on
    if (on) playhead.style.transform = `translateX(${px(tick!)}px)`
  }
  /** Call when another clip opens: the next update re-centres on its notes. */
  const reset = () => { centered = 0; touched = false; sel.clear(); lastLen = 0 }
  /** Light (or let go of) the key of a note played live, from the computer keyboard or a MIDI keyboard. */
  const lit = new Map<number, number>() // pitch -> how many sources hold it
  function liveKey(pitch: number, on: boolean) {
    const n = Math.max(0, (lit.get(pitch) ?? 0) + (on ? 1 : -1))
    if (n) lit.set(pitch, n)
    else lit.delete(pitch)
    keys.querySelector<HTMLElement>(`.pr-key[data-pitch="${pitch}"]`)?.classList.toggle('live', n > 0)
  }
  function clearLive() {
    lit.clear()
    for (const k of keys.querySelectorAll('.pr-key.live')) k.classList.remove('live')
  }
  return { el, scroller: scroll, keysWidth: KEYS_W, update, reset, setPlayhead, commands, liveKey, clearLive }
}
