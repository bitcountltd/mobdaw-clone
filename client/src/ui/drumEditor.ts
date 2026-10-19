// The drum editor: every param of the drum synth selected in the kit panel, in a panel next to the kit. Its header has
// the drum's name, its sound menu (and which sound the values match), arrows to step through the sounds of that
// sound's category, and a button to hear it; under it a drawing of the hit, then the param groups in two rows.
// The knobs are the same as the rack's other panels (ui/devices.ts `paramSet`): automation menus, live drags, other
// users' drags and lanes all work the same.
import { DEVICES, KEY_MIN, type Device } from '@mobdaw/shared'
import { h } from '../dom'
import { icon } from '../theme/icons'
import { NO_AUTO, type AutoInfo } from './automation'
import { paramSet, type CardDeps } from './devices'
import { DRUM_GROUPS, drumDrawing, drumKnobName } from './drumParts'
import { noteName } from './noteName'
import { popover } from './popover'

export function drumEditor(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  let current = dev
  const el = h('div', { className: `unit drum-ed t${dev.type}`, 'data-device': id })

  // --- header
  const name = h('button', { className: 'unit-name', title: 'this drum: click for its menu' })
  const key = h('span', { className: 'unit-type ded-key' })
  const preset = h('button', { className: 'unit-preset', title: 'sounds', disabled: deps.readOnly }, h('span', {}), icon('chevron-down', 12))
  const prev = h('button', { className: 'icon-btn sm ded-step prev', title: 'previous sound in this category', disabled: deps.readOnly, onclick: () => deps.stepSound?.(id, -1) }, icon('chevron-right', 14))
  const next = h('button', { className: 'icon-btn sm ded-step', title: 'next sound in this category', disabled: deps.readOnly, onclick: () => deps.stepSound?.(id, 1) }, icon('chevron-right', 14))
  const play = h('button', { className: 'icon-btn sm ded-play', title: 'hear it' }, icon('play', 12))
  const head = h('div', { className: 'unit-head' },
    h('i', { className: 'ded-mark', 'aria-hidden': 'true' }), name, key, h('span', { className: 'ded-sound' }, prev, preset, next), h('span', { className: 'grow' }), play)
  preset.onclick = () => deps.presets(current).menu?.(preset)
  name.onclick = () => {
    if (deps.readOnly) return
    popover(name, [
      { label: 'rename', run: () => deps.rename(id), icon: 'edit' },
      { label: current.bypass ? 'turn on' : 'turn off', run: () => deps.bypass(id, !current.bypass), icon: 'power' },
      'sep',
      { label: 'remove drum', run: () => deps.remove(id), icon: 'trash', danger: true },
    ])
  }
  play.onpointerdown = (e) => {
    if (e.button !== 0 || !deps.audition) return
    const k = current.keyLo ?? KEY_MIN
    play.classList.add('on')
    deps.audition(current.trackId, k, true)
    const up = () => (play.classList.remove('on'), deps.audition?.(current.trackId, k, false), removeEventListener('pointerup', up), removeEventListener('pointercancel', up))
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  // --- body: the drawing, then the groups (body on the first row with the drawing; noise, click and out under it)
  const drawing = drumDrawing(176, 52)
  const ps = paramSet(dev, deps, { redraw: () => redraw() })
  const group = (g: (typeof DRUM_GROUPS)[number]) => h('div', { className: `unit-group ded-${g.label}` },
    h('div', { className: 'unit-glabel' }, g.label),
    h('div', { className: 'unit-knobs' }, ...g.ids.map((pid) => ps.make(ps.pdef(pid), 34, drumKnobName(pid, 0), ps.pdef(pid).min < 0))))
  const [bodyG, noiseG, clickG, outG] = DRUM_GROUPS
  const body = h('div', { className: 'unit-body ded-body' },
    h('div', { className: 'unit-groups' }, h('div', { className: 'unit-group ded-drawbox' }, h('div', { className: 'unit-glabel' }, 'hit'), h('div', { className: 'unit-draw' }, drawing.el)), group(bodyG)),
    h('div', { className: 'unit-groups' }, group(noiseG), group(clickG), group(outG)))
  el.append(head, body)

  function redraw() {
    drawing.draw(ps.val)
    for (const pid of [5, 6]) ps.ctls.get(pid)?.rename(drumKnobName(pid, ps.val(0)))
    // the noise's own controls fade while it is silent (they still work)
    noiseG.ids.slice(1).forEach((pid) => ps.ctls.get(pid)?.el.classList.toggle('quiet', ps.val(8) <= 0.001))
    clickG.ids.slice(1).forEach((pid) => ps.ctls.get(pid)?.el.classList.toggle('quiet', ps.val(15) <= 0.001))
  }

  let lastRemote = new Map<number, number>()
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = d
    lastRemote = remote
    const text = d.name ?? def?.name ?? 'drum'
    if (name.textContent !== text) name.textContent = text
    key.textContent = `on ${noteName(d.keyLo ?? KEY_MIN)}`
    el.classList.toggle('bypassed', !!d.bypass)
    const p = deps.presets(d)
    const label = p.current ?? 'custom'
    const span = preset.firstElementChild as HTMLElement
    if (span.textContent !== label) span.textContent = label
    preset.classList.toggle('none', !p.current)
    preset.title = p.current ? `sounds (now: ${p.current})` : 'sounds (these settings are not one of them)'
    for (const b of [preset, prev, next]) b.hidden = deps.readOnly || !p.menu
    ps.update(d, remote, auto)
    redraw()
  }
  update(dev, new Map())
  return {
    el, update,
    refresh: (auto: Map<string, AutoInfo>) => update(current, lastRemote, auto),
    /** The pad is moving one of this drum's params. */
    show: ps.show,
  }
}
