// The dock's devices tab: the focused track's rack, a row of hardware-like panels that scrolls sideways. A MIDI track's
// instruments come first (its drums as one kit panel of pads, then any synths), then the effects in chain order; the
// master shows the effects on the whole mix. Presets come from content/presets.ts, and anything from the browser can
// be dropped onto the rack. Pressing a drum's pad selects it: a drum synth then shows all its params in the drum
// editor next to the kit (ui/drumEditor.ts), with its sounds from content/drumSounds.ts.
import {
  DEVICES, DRUM_SYNTH, EFFECTS, FINNWAVE, MASTER_TRACK, SIMPLE_FILTER, addDevice, addDrum, deleteDevice, getDevices, getTracks, isDrum, orderBetween,
  setParam, trackColor, updateDevice, type AwarenessState, type Device, type ParamTarget,
} from '@mobdaw/shared'
import {
  DRUM_KITS, EFFECT_PRESETS, INSTRUMENT_PRESETS, addEffectPreset, addInstrument, applyInstrumentPreset, clampParams, replaceDrumKit,
  type InstrumentCategory,
} from '../../content/presets'
import { applyDrumSound, soundMatching, soundNearest, soundStep } from '../../content/drumPick'
import { DRUM_CATEGORIES, DRUM_SOUNDS, drumSound, type DrumSound } from '../../content/drumSounds'
import { h } from '../../dom'
import { icon } from '../../theme/icons'
import { deviceCard, drumPad, type CardDeps } from '../../ui/devices'
import { drumEditor } from '../../ui/drumEditor'
import type { FilterChange, FilterMember } from '../../ui/filterCurve'
import { popoverPanel } from '../../ui/popover'
import { applyDrop, canDrop, hasPayload, readDragPayload } from '../drops'
import type { Studio } from '../studio'
import './rack.css'

const NO_DRAGS = new Map<number, number>()

type MenuEntry = { label: string; run: () => void; hint?: string; title?: string; on?: boolean }
/** A menu of labelled sections laid out in `cols` columns (preset pickers): picking an entry closes it. */
function sectionMenu(anchor: HTMLElement, sections: { label: string; items: MenuEntry[] }[], cols: number) {
  let close = () => {}
  const body = h('div', { className: 'pick-menu', role: 'menu' }, ...sections.map((s) => h('div', { className: 'pick-sec' },
    h('div', { className: 'menu-label' }, s.label),
    ...s.items.map((it) => h('button', { className: `item${it.on ? ' current' : ''}`, role: 'menuitem', title: it.title, onclick: () => (close(), it.run()) },
      h('span', {}, it.label), it.hint ? h('span', { className: 'kbd-hint' }, it.hint) : null)))))
  body.style.setProperty('--cols', String(cols))
  body.style.setProperty('--cols-narrow', String(Math.min(cols, 2)))
  body.addEventListener('keydown', (e) => {
    const btns = [...body.querySelectorAll<HTMLButtonElement>('button')]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    btns[(i + d + btns.length) % btns.length].focus()
  })
  close = popoverPanel(anchor, body)
  if (anchor.matches(':focus-visible')) body.querySelector<HTMLButtonElement>('button')?.focus()
}
const FOLD_KEY = 'mobdaw.rack.collapsed'
const CATEGORIES: [InstrumentCategory, string][] = [['keys', 'Keys'], ['bass', 'Bass'], ['lead', 'Lead'], ['pad', 'Pads'], ['pluck', 'Plucks'], ['fx', 'Textures']]
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
type Card = ReturnType<typeof deviceCard> | ReturnType<typeof drumPad>

/** The drum a track's drum editor shows: the one picked on it, else its first drum synth, else its first drum. */
export const selectedDrum = (drums: Device[], picked: string | undefined): Device | undefined =>
  drums.find((d) => d.id === picked) ?? drums.find((d) => d.type === DRUM_SYNTH) ?? drums[0]

export function mountRack(st: Studio) {
  const { doc, undo, readOnly } = st
  const cards = new Map<string, Card>()
  /** Each filter's run: the ids of the filters adjacent to it in its chain (itself included), in chain order. */
  const runs = new Map<string, string[]>()
  const folded = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[] } catch { return [] } })())

  const header = (label: string) => h('div', { className: 'rack-rail' }, h('span', {}, label))
  // instruments: the kit, the synths, a slot to add one
  const pads = h('div', { className: 'kit-pads' })
  const kitName = h('span', { className: 'kit-count dim' })
  const kitMenu = h('button', { className: 'unit-preset', title: 'replace the drums with a kit', disabled: readOnly }, h('span', {}, 'load kit'), icon('chevron-down', 12))
  const kitAdd = h('button', { className: 'btn sm', title: 'add a drum on the next free key', disabled: readOnly }, icon('plus', 14), 'drum')
  const kit = h('div', { className: 'unit kit' },
    h('div', { className: 'unit-head' }, h('span', { className: 'unit-name static' }, 'Drum kit'), kitName, kitMenu, h('span', { className: 'grow' }), kitAdd),
    pads)
  // the kit and the drum editor of its selected drum sit together (no signal arrow between them)
  const kitWrap = h('div', { className: 'kit-wrap' }, kit)
  /** The drum each track's editor shows (by track id; in memory only). */
  const selDrum = new Map<string, string>()
  /** The sound last put on each drum (by device id): the arrows step on from it after its values are changed. */
  const lastSound = new Map<string, string>()
  let editor: { id: string; card: ReturnType<typeof drumEditor> } | null = null
  const addSynth = slot('add an instrument', () => instrumentMenu(addSynth))
  const synths = h('div', { className: 'rack-row' })
  const synthSec = h('div', { className: 'rack-sec' }, header('Instrument'), synths)
  // effects
  const addFx = slot('add an effect', () => effectMenu(addFx))
  const fx = h('div', { className: 'rack-row' })
  const fxSec = h('div', { className: 'rack-sec' }, header('Effects'), fx)
  const chain = h('div', { className: 'rack-chain' }, synthSec, fxSec)
  const empty = h('div', { className: 'dock-empty' },
    h('div', { className: 'dock-empty-icon' }, icon('effect', 22)),
    h('p', {}, 'Click a track header to see its instruments and effects here.'),
    h('p', { className: 'dim' }, 'Or click master for the effects on the whole mix.'))
  const el = h('div', { className: 'rack' }, empty, chain)
  const addFxTool = h('button', { className: 'btn sm', title: 'add an effect to the end of the chain', disabled: readOnly, onclick: () => effectMenu(addFxTool) }, icon('plus', 14), 'effect')
  const addSynthTool = h('button', { className: 'btn sm', title: 'add an instrument', disabled: readOnly, onclick: () => instrumentMenu(addSynthTool) }, icon('plus', 14), 'instrument')
  const tools = h('div', { className: 'rack-tools' }, addSynthTool, addFxTool)

  function slot(text: string, run: () => void) {
    const b = h('button', { className: 'rack-slot', title: text, disabled: readOnly, onclick: run }, icon('plus', 18), h('span', {}, text.replace('add an ', '')))
    return b
  }

  const target = () => st.ui.focusTrack
  const pick = (run: () => void) => () => { undo.stopCapturing(); run(); undo.stopCapturing() }
  function instrumentMenu(anchor: HTMLElement) {
    const id = target()
    if (!id || id === MASTER_TRACK) return
    sectionMenu(anchor, [
      ...CATEGORIES.map(([cat, label]) => ({ label, items: INSTRUMENT_PRESETS.filter((x) => x.category === cat).map((p) => ({ label: p.name, run: pick(() => addInstrument(doc, id, p)) })) })),
      { label: 'Drum kits', items: DRUM_KITS.map((k) => ({ label: k.name, hint: count(k.drums.length, 'drum'), run: pick(() => replaceDrumKit(doc, id, k)) })) },
      { label: 'Start from scratch', items: [{ label: 'Blank synth', title: 'a Finnwave synth on its default settings', run: pick(() => addDevice(doc, id, FINNWAVE)) }, { label: 'One drum', title: 'a drum synth on the next free key', run: pick(() => addDrum(doc, id)) }] },
    ], 4)
  }
  function effectMenu(anchor: HTMLElement) {
    const id = target()
    if (!id) return
    sectionMenu(anchor, [
      { label: 'Effects', items: EFFECTS.map((d) => ({ label: d.name, run: pick(() => addDevice(doc, id, d.type)) })) },
      { label: 'Presets and chains', items: EFFECT_PRESETS.map((p) => ({ label: p.name, hint: p.devices.length > 1 ? count(p.devices.length, 'effect') : DEVICES[p.devices[0].type]?.name ?? '', title: p.devices.map((d) => DEVICES[d.type]?.name).join(' → '), run: pick(() => addEffectPreset(doc, id, p)) })) },
    ], 2)
  }
  kitMenu.onclick = () => {
    const id = target()
    if (!id || id === MASTER_TRACK) return
    sectionMenu(kitMenu, [{ label: 'Replace the drums with', items: DRUM_KITS.map((k) => ({ label: k.name, hint: count(k.drums.length, 'drum'), run: pick(() => replaceDrumKit(doc, id, k)) })) }], 1)
  }
  kitAdd.onclick = () => {
    const id = target()
    if (!id || id === MASTER_TRACK) return
    undo.stopCapturing()
    selDrum.set(id, addDrum(doc, id)) // (the new drum opens in the editor)
    undo.stopCapturing()
  }

  // --- drum sounds
  let auditionOff: (() => void) | null = null
  /** Play a drum briefly (after its sound changed). */
  function hear(dev: Device) {
    auditionOff?.()
    const k = dev.keyLo ?? 60
    st.pb?.noteLive(dev.trackId, k, 1, true)
    const t = setTimeout(() => auditionOff?.(), 350)
    auditionOff = () => { clearTimeout(t); st.pb?.noteLive(dev.trackId, k, 1, false); auditionOff = null }
  }
  function useSound(deviceId: string, s: DrumSound) {
    pick(() => applyDrumSound(doc, deviceId, s))()
    lastSound.set(deviceId, s.id)
    const dev = getDevices(doc).find((x) => x.id === deviceId)
    if (dev) hear(dev)
  }
  /** The sound a drum is: the one its values match, else the one last put on it, else the nearest. */
  const soundOf = (dev: Device) => soundMatching(dev) ?? drumSound(lastSound.get(dev.id) ?? '') ?? soundNearest(dev)
  function stepSound(deviceId: string, dir: 1 | -1) {
    const dev = getDevices(doc).find((x) => x.id === deviceId)
    const s = dev && soundStep(soundOf(dev), dir)
    if (s) useSound(deviceId, s)
  }

  /** The preset menu of a device, and the preset its values match. */
  function presets(dev: Device): { menu: ((anchor: HTMLElement) => void) | null; current: string | null } {
    const def = DEVICES[dev.type]
    if (!def) return { menu: null, current: null }
    const reset = { label: 'Default settings', run: () => commitMany(dev.id, Object.fromEntries(def.params.map((p) => [p.id, p.def]))) }
    if (dev.type === DRUM_SYNTH) {
      // exactly a sound, or a kit's take on one ("Studio kick · edited")
      const exact = soundMatching(dev)
      const cur = exact ?? soundNearest(dev)
      return {
        current: exact ? exact.name : cur ? `${cur.name} · edited` : null,
        menu: (a) => {
          const secs = DRUM_CATEGORIES.map(([cat, label]) => ({
            label, items: DRUM_SOUNDS.filter((x) => x.category === cat).map((x) => ({ label: x.name, on: x.id === cur?.id, run: () => useSound(dev.id, x) })),
          })).filter((x) => x.items.length)
          sectionMenu(a, [...secs, { label: 'Start over', items: [{ ...reset, title: 'every param back to its default (the name stays)' }] }], Math.min(4, secs.length + 1))
        },
      }
    }
    if (dev.type === FINNWAVE) {
      const cur = INSTRUMENT_PRESETS.find((p) => p.name === dev.name && same(dev, p.params))?.name ?? null
      return {
        current: cur,
        menu: (a) => sectionMenu(a, [
          ...CATEGORIES.map(([cat, label]) => ({ label, items: INSTRUMENT_PRESETS.filter((x) => x.category === cat).map((p) => ({ label: p.name, on: p.name === cur, run: pick(() => applyInstrumentPreset(doc, dev.id, p)) })) })),
          { label: 'Start over', items: [reset] },
        ], 4),
      }
    }
    if (def.instrument) return { menu: (a) => sectionMenu(a, [{ label: def.name, items: [reset] }], 1), current: null }
    const singles = EFFECT_PRESETS.filter((p) => p.devices.length === 1 && p.devices[0].type === dev.type)
    const cur = singles.find((p) => same(dev, p.devices[0].params))?.name ?? null
    return {
      current: cur,
      menu: (a) => sectionMenu(a, [{ label: def.name, items: [...singles.map((p) => ({ label: p.name, on: p.name === cur, run: () => commitMany(dev.id, clampParams(dev.type, p.devices[0].params)) })), reset] }], 1),
    }
  }
  const same = (dev: Device, params: Record<string, number>) =>
    Object.entries(clampParams(dev.type, params)).every(([k, v]) => Math.abs((dev.params?.[Number(k)] ?? DEVICES[dev.type].params.find((p) => p.id === Number(k))?.def ?? 0) - v) < 1e-6)

  const commitMany = (d: string, values: Record<number, number>) => {
    undo.stopCapturing()
    doc.transact(() => { for (const [p, v] of Object.entries(values)) setParam(doc, d, Number(p), v) })
    undo.stopCapturing()
  }
  const cardOf = (id: string) => cards.get(id)
  const cardDeps: CardDeps = {
    readOnly,
    live: (d, p, v) => st.pb?.live(d, p, v),
    drag: (d: AwarenessState['dragging']) => st.s.setLocal({ dragging: d }),
    commit: (d, p, v) => {
      undo.stopCapturing()
      setParam(doc, d, p, v)
      undo.stopCapturing()
    },
    commitMany,
    bypass: (d, b) => updateDevice(doc, d, { bypass: b }),
    remove: (d) => { undo.stopCapturing(); deleteDevice(doc, d) },
    keys: (d, lo, hi) => {
      undo.stopCapturing()
      updateDevice(doc, d, { keyLo: lo, keyHi: hi })
      undo.stopCapturing()
    },
    rename: (d) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      const name = dev && prompt('name', dev.name ?? DEVICES[dev.type]?.name ?? '')?.trim()
      if (name) updateDevice(doc, d, { name })
    },
    reorderStart: () => el.classList.add('reordering'),
    reorderEnd: () => el.classList.remove('reordering'),
    reorderDrop: (d, before) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      if (!dev) return
      const synth = !!DEVICES[dev.type]?.instrument // instruments and effects are separate rows
      const list = getDevices(doc).filter((x) => x.trackId === dev.trackId && x.id !== d && !!DEVICES[x.type]?.instrument === synth && !isDrum(x))
      const i = before == null ? list.length : list.findIndex((x) => x.id === before)
      if (i < 0) return
      undo.stopCapturing()
      updateDevice(doc, d, { order: orderBetween(list[i - 1]?.order, list[i]?.order) })
      undo.stopCapturing()
    },
    run: (d: string, self: FilterMember) => (runs.get(d) ?? [d]).flatMap((o) => (o === d ? [self] : [cardOf(o)?.member() ?? []].flat())),
    changed: (d: string) => { for (const o of runs.get(d) ?? []) if (o !== d) cardOf(o)?.redrawCurve() },
    dragFilter: (d: string, change: FilterChange) => cardOf(d)?.dragMove(change),
    dragFilterEnd: (d: string) => cardOf(d)?.dragEnd(),
    autoMenu: (label: HTMLElement, t: ParamTarget) => st.autoMenu(label, t),
    presets,
    collapsed: (d) => folded.has(d),
    setCollapsed: (d, on) => {
      if (on) folded.add(d)
      else folded.delete(d)
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded].slice(-200))) } catch { /* not remembered */ }
      draw()
    },
    audition: (trackId, pitch, on) => st.pb?.noteLive(trackId, pitch, 1, on),
    mirror: (d, p, v) => {
      const c = cards.get(d)
      if (c && 'show' in c) c.show(p, v)
      if (editor?.id === d) editor.card.show(p, v)
    },
    selectDrum: (d) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      if (!dev || selDrum.get(dev.trackId) === d) return
      selDrum.set(dev.trackId, d)
      draw()
      editor?.card.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    },
    stepSound,
  }

  function findRuns(list: Device[]) {
    let run: string[] = []
    const flush = () => { for (const id of run) runs.set(id, run); run = [] }
    for (const d of list) {
      if (d.type === SIMPLE_FILTER && !d.bypass) run.push(d.id)
      else flush()
    }
    flush()
  }

  function place(box: HTMLElement, list: Device[], tail: HTMLElement | null, lead: HTMLElement | null = null, pad = false) {
    const want: HTMLElement[] = []
    if (lead) want.push(lead)
    for (const d of list) {
      let c = cards.get(d.id)
      if (!c) cards.set(d.id, (c = pad ? drumPad(d, cardDeps) : deviceCard(d, cardDeps)))
      c.update(d, st.remoteDrags.get(d.id) ?? NO_DRAGS, st.auto.info(d.id))
      want.push(c.el)
    }
    if (tail) want.push(tail)
    want.forEach((w, i) => { if (box.children[i] !== w) box.insertBefore(w, box.children[i] ?? null) })
    while (box.children.length > want.length) box.lastElementChild!.remove()
  }

  function draw() {
    const id = st.ui.focusTrack
    const isMaster = id === MASTER_TRACK
    const tracks = getTracks(doc)
    const ti = id && !isMaster ? tracks.findIndex((t) => t.id === id) : -1
    const track = ti >= 0 ? tracks[ti] : undefined
    const shown = isMaster || !!track
    empty.hidden = shown
    chain.hidden = !shown
    tools.hidden = !shown || readOnly
    el.classList.toggle('locked', !!track && st.locks.has(track.id))
    el.style.setProperty('--tc', isMaster ? 'var(--accent)' : track ? trackColor(track, ti) : 'var(--accent)')
    el.style.setProperty('--knob-c', 'var(--tc)')
    const mine = shown ? getDevices(doc).filter((d) => d.trackId === id) : []
    const ids = new Set(mine.map((d) => d.id))
    for (const [cid, c] of cards) if (!ids.has(cid)) { c.el.remove(); cards.delete(cid) }
    if (!shown || track?.kind !== 'midi') dropEditor()
    if (!shown) return
    const midi = track?.kind === 'midi'
    synthSec.hidden = !midi
    addSynthTool.hidden = !midi
    const instruments = mine.filter((d) => DEVICES[d.type]?.instrument)
    const drums = instruments.filter(isDrum)
    const others = instruments.filter((d) => !isDrum(d))
    const effects = mine.filter((d) => !DEVICES[d.type]?.instrument)
    runs.clear()
    if (midi) {
      place(pads, drums, null, null, true)
      kitName.textContent = drums.length ? count(drums.length, 'drum') : ''
      drawEditor(id!, drums)
      place(synths, others, others.length || drums.length ? null : addSynth, drums.length ? kitWrap : null)
      if (!drums.length) kitWrap.remove()
      ;(synthSec.querySelector('.rack-rail span') as HTMLElement).textContent = drums.length && !others.length ? 'Drums' : 'Instrument'
    }
    findRuns(effects)
    place(fx, effects, addFx)
    for (const d of effects) cards.get(d.id)?.redrawCurve() // again, now that every panel is in place (its run's neighbours)
    fxSec.classList.toggle('empty', !effects.length)
  }

  /**
   * The selected drum (the one picked on this track, else its first drum synth, else its first drum) and, when it is a
   * drum synth, its editor after the kit.
   */
  function drawEditor(trackId: string, drums: Device[]) {
    const sel = selectedDrum(drums, selDrum.get(trackId))
    for (const d of drums) {
      const c = cards.get(d.id)
      if (c && 'select' in c) c.select(d.id === sel?.id && sel.type === DRUM_SYNTH)
    }
    if (!sel || sel.type !== DRUM_SYNTH) return dropEditor()
    if (editor?.id !== sel.id) {
      dropEditor()
      editor = { id: sel.id, card: drumEditor(sel, cardDeps) }
      kitWrap.append(editor.card.el)
    }
    editor.card.update(sel, st.remoteDrags.get(sel.id) ?? NO_DRAGS, st.auto.info(sel.id))
  }
  function dropEditor() {
    editor?.card.el.remove()
    editor = null
  }

  /** The playhead moved: repaint the controls a lane drives. */
  function refresh() {
    for (const [id, c] of cards) if (st.auto.infos.has(id)) c.refresh(st.auto.info(id))
    if (editor && st.auto.infos.has(editor.id)) editor.card.refresh(st.auto.info(editor.id))
  }

  // drops from the browser land on the focused track (or the master)
  el.addEventListener('dragover', (e) => {
    if (!hasPayload(e) || readOnly) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    el.classList.add('drop-on')
  })
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget as Node)) el.classList.remove('drop-on') })
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-on')
    const p = readDragPayload(e)
    if (!p) return
    e.preventDefault()
    const id = target()
    undo.stopCapturing()
    const landed = applyDrop(st, p, { trackId: id && canDrop(st, p, id) ? id : null })
    if (landed && landed !== id) st.status('That sound needs a different kind of track, so it went on a new one.')
  })

  const offs = [
    st.on('doc', draw),
    st.on('ui', (p) => { if ('focusTrack' in p) draw() }),
    st.on('tick', refresh),
  ]
  draw()
  return { el, tools, destroy: () => { auditionOff?.(); offs.forEach((f) => f()) } }
}
