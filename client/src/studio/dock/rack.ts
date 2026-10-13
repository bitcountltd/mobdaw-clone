// The dock's devices tab: the focused track's device chain (a MIDI track's instruments, then its effects), or the master
// bus's effects when the master is focused. Cards are the existing ui/devices.ts cards.
import {
  DEVICES, EFFECTS, INSTRUMENTS, LOFI_DRUM, MASTER_TRACK, SIMPLE_FILTER, addDevice, addDrum, deleteDevice, getDevices, getTracks, orderBetween, setParam,
  updateDevice, type AwarenessState, type Device, type ParamTarget,
} from '@mobdaw/shared'
import { h } from '../../dom'
import { deviceCard } from '../../ui/devices'
import type { FilterChange, FilterMember } from '../../ui/filterCurve'
import { popover } from '../../ui/popover'
import type { Studio } from '../studio'

const NO_DRAGS = new Map<number, number>()
type Card = ReturnType<typeof deviceCard>

export function mountRack(st: Studio) {
  const { doc, undo, readOnly } = st
  const cards = new Map<string, Card>()
  /** Each filter's run: the ids of the filters adjacent to it in its chain (itself included), in chain order. */
  const runs = new Map<string, string[]>()
  let reordering = false // a card is being dragged by its title bar: merged filter views split until it lands

  const title = h('strong', { className: 'rack-title' })
  const kind = h('span', { className: 'dim' })
  const synthLabel = h('div', { className: 'rack-label dim' }, 'instruments')
  const synths = h('div', { className: 'rack-row' })
  const addSynth = h('button', { className: 'add-fx', title: 'add instrument', disabled: readOnly, onclick: () => {
    const id = st.ui.focusTrack
    if (id) popover(addSynth, INSTRUMENTS.map((d) => [d.name, () => (d.type === LOFI_DRUM ? addDrum(doc, id) : addDevice(doc, id, d.type))] as [string, () => void]))
  } }, '+')
  const fxLabel = h('div', { className: 'rack-label dim' }, 'effects')
  const fx = h('div', { className: 'rack-row' })
  const addFx = h('button', { className: 'add-fx', title: 'add effect', disabled: readOnly, onclick: () => {
    const id = st.ui.focusTrack
    if (id) popover(addFx, EFFECTS.map((d) => [d.name, () => addDevice(doc, id, d.type)] as [string, () => void]))
  } }, '+')
  const empty = h('div', { className: 'dock-empty dim' }, 'click a track header (or the master) to see its devices here.')
  const synthGroup = h('div', { className: 'rack-group' }, synthLabel, synths)
  const chain = h('div', { className: 'rack-chain' }, synthGroup, h('div', { className: 'rack-group' }, fxLabel, fx))
  const el = h('div', { className: 'rack' }, empty, h('div', { className: 'rack-head' }, title, kind), chain)

  const cardOf = (id: string) => cards.get(id)
  const cardDeps = {
    readOnly,
    live: (d: string, p: number, v: number) => st.pb?.live(d, p, v),
    drag: (d: AwarenessState['dragging']) => st.s.setLocal({ dragging: d }),
    commit: (d: string, p: number, v: number) => {
      undo.stopCapturing()
      setParam(doc, d, p, v)
      undo.stopCapturing()
    },
    commitMany: (d: string, values: Record<number, number>) => {
      undo.stopCapturing()
      for (const [p, v] of Object.entries(values)) setParam(doc, d, Number(p), v)
      undo.stopCapturing()
    },
    bypass: (d: string, b: boolean) => updateDevice(doc, d, { bypass: b }),
    remove: (d: string) => deleteDevice(doc, d),
    keys: (d: string, lo: number, hi: number) => {
      undo.stopCapturing()
      updateDevice(doc, d, { keyLo: lo, keyHi: hi })
      undo.stopCapturing()
    },
    rename: (d: string) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      const name = dev && prompt('name', dev.name ?? DEVICES[dev.type]?.name ?? '')?.trim()
      if (name) updateDevice(doc, d, { name })
    },
    reorderStart: () => { reordering = true; draw() },
    reorderEnd: () => { reordering = false; draw() },
    reorderDrop: (d: string, before: string | null) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      if (!dev) return
      const synth = !!DEVICES[dev.type]?.instrument // instruments and effects are separate rows
      const list = getDevices(doc).filter((x) => x.trackId === dev.trackId && x.id !== d && !!DEVICES[x.type]?.instrument === synth)
      const i = before == null ? list.length : list.findIndex((x) => x.id === before)
      if (i < 0) return
      undo.stopCapturing()
      updateDevice(doc, d, { order: orderBetween(list[i - 1]?.order, list[i]?.order) })
      undo.stopCapturing()
    },
    run: (d: string, self: FilterMember) => reordering && el.querySelector('.dev.reordering') ? [self] : (runs.get(d) ?? [d]).flatMap((o) => (o === d ? [self] : [cardOf(o)?.member() ?? []].flat())),
    changed: (d: string) => { const host = runs.get(d)?.[0]; if (host && host !== d) cardOf(host)?.redrawCurve() },
    dragFilter: (d: string, change: FilterChange) => cardOf(d)?.dragMove(change),
    dragFilterEnd: (d: string) => cardOf(d)?.dragEnd(),
    autoMenu: (label: HTMLElement, t: ParamTarget) => st.autoMenu(label, t),
  }

  function findRuns(list: Device[]) {
    let run: string[] = []
    const flush = () => { for (const id of run) runs.set(id, run); run = [] }
    for (const d of list) {
      if (d.type === SIMPLE_FILTER) run.push(d.id)
      else flush()
    }
    flush()
  }

  function place(box: HTMLElement, list: Device[], add: HTMLElement) {
    list.forEach((d, i) => {
      let c = cards.get(d.id)
      if (!c) cards.set(d.id, (c = deviceCard(d, cardDeps)))
      if (box.children[i] !== c.el) box.insertBefore(c.el, box.children[i] ?? null)
      c.update(d, st.remoteDrags.get(d.id) ?? NO_DRAGS, st.auto.info(d.id))
    })
    if (box.lastElementChild !== add) box.append(add)
  }

  function draw() {
    const id = st.ui.focusTrack
    const isMaster = id === MASTER_TRACK
    const track = id && !isMaster ? getTracks(doc).find((t) => t.id === id) : undefined
    const shown = isMaster || !!track
    empty.hidden = shown
    el.classList.toggle('none', !shown)
    el.classList.toggle('locked', !!track && st.locks.has(track.id))
    const mine = shown ? getDevices(doc).filter((d) => d.trackId === id) : []
    const ids = new Set(mine.map((d) => d.id))
    for (const [cid, c] of cards) if (!ids.has(cid)) { c.el.remove(); cards.delete(cid) }
    if (!shown) return
    title.textContent = isMaster ? 'master' : track!.name
    kind.textContent = isMaster ? 'effects on the whole mix' : `${track!.kind} track`
    const midi = track?.kind === 'midi'
    synthGroup.hidden = !midi
    const instruments = mine.filter((d) => DEVICES[d.type]?.instrument)
    const effects = mine.filter((d) => !DEVICES[d.type]?.instrument)
    runs.clear()
    if (midi) place(synths, instruments, addSynth)
    findRuns(effects)
    place(fx, effects, addFx)
    for (const d of effects) cards.get(d.id)?.redrawCurve() // again, now that every card is in place (neighbours)
  }

  /** The playhead moved: repaint the controls a lane drives. */
  function refresh() {
    for (const [id, c] of cards) if (st.auto.infos.has(id)) c.refresh(st.auto.info(id))
  }

  const offs = [
    st.on('doc', draw),
    st.on('ui', (p) => { if ('focusTrack' in p) draw() }),
    st.on('tick', refresh),
  ]
  draw()
  return { el, destroy: () => offs.forEach((f) => f()) }
}
