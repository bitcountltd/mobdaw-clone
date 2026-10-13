// #/kit: every theme control and icon on one page, for review (dev only, linked from nowhere).
import { TRACK_COLORS } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { fader, iconButton, knob, meter, numberField, segmented, toggle, tooltip } from '../theme/controls'
import { icon, ICON_NAMES } from '../theme/icons'
import { popover } from '../ui/popover'
import './kit.css'

const sec = (title: string, ...kids: (Node | null)[]) => h('section', { className: 'kit-sec' }, h('h2', {}, title), ...kids)
const row = (...kids: Node[]) => h('div', { className: 'kit-row' }, ...kids)

export function kitPage() {
  const icons = h('div', { className: 'kit-icons' },
    ...ICON_NAMES.map((n) => h('div', { className: 'kit-icon', title: n }, icon(n), h('span', {}, n))))
  const iconsLg = row(...(['play', 'record', 'loop', 'metronome', 'mixer', 'piano', 'settings', 'automation'] as const).map((n) => icon(n, 32)))

  const buttons = row(
    h('button', {}, 'quiet'),
    h('button', { className: 'on' }, 'on'),
    h('button', { className: 'on', 'data-tone': 'rec' }, 'record'),
    h('button', { disabled: true }, 'disabled'),
    h('button', { className: 'btn' }, 'cancel'),
    h('button', { className: 'btn primary' }, 'export'),
    h('button', { className: 'btn danger' }, 'delete'),
    h('button', { className: 'link' }, 'a link button'),
  )
  const play = toggle({ icon: 'play' }, { title: 'play / pause (space)' })
  const icons2 = row(
    iconButton('rewind', 'to start (home)'), play.el,
    toggle({ icon: 'record' }, { title: 'record (r)', tone: 'rec', on: true }).el,
    toggle({ icon: 'loop' }, { title: 'loop (l)', on: true }).el,
    toggle({ icon: 'metronome' }, { title: 'click (c)' }).el,
    iconButton('undo', 'undo (ctrl+z)'), iconButton('redo', 'redo (ctrl+shift+z)'),
    toggle('mute', { className: 'small' }).el, toggle('solo', { on: true }).el, toggle('arm', { tone: 'rec', on: true }).el,
  )
  const tipped = h('button', { className: 'btn' }, 'hover me')
  tooltip(tipped, 'export audio', 'ctrl+e')

  const seg = row(
    segmented([{ value: 'arrange', label: 'arrange', icon: 'arrange' }, { value: 'mix', label: 'mix', icon: 'mixer' }], 'arrange').el,
    segmented(['1/4', '1/8', '1/16', '1/32'], '1/16').el,
  )

  const read = h('span', { className: 'dim num' }, '')
  const knobs = row(
    knob({ value: 2000, min: 20, max: 20000, def: 2000, scale: 'log', label: 'cutoff', unit: 'hz', onInput: (v) => (read.textContent = v.toFixed(1)) }).el,
    knob({ value: 0.3, min: 0, max: 1, def: 0.3, label: 'resonance' }).el,
    knob({ value: 300, min: 0, max: 5000, def: 300, scale: 'pow', label: 'decay', unit: 'ms' }).el,
    knob({ value: -0.3, min: -1, max: 1, def: 0, bipolar: true, label: 'pan', size: 28, color: TRACK_COLORS[1] }).el,
    knob({ value: 0.7, min: 0, max: 1, def: 0.5, label: 'mix', size: 44, color: TRACK_COLORS[0] }).el,
    knob({ value: 0.5, min: 0, max: 1, label: 'disabled', disabled: true }).el,
    read,
  )

  const meters = TRACK_COLORS.slice(0, 4).map(() => meter({ stereo: true }))
  const hm = meter({ orientation: 'horizontal', stereo: true })
  const faders = row(
    ...meters.map((m, i) => h('div', { className: 'kit-strip', style: `--c:${TRACK_COLORS[i]}` },
      fader({ value: [1, 0.5, 1.6, 0.1][i], color: TRACK_COLORS[i] }).el, m.el)),
    h('div', { className: 'kit-hfader' },
      fader({ value: 0.8, orientation: 'horizontal', color: TRACK_COLORS[2] }).el,
      hm.el,
      fader({ value: 1, orientation: 'horizontal' }).el),
  )
  let t = 0
  const level = (k: number) => Math.abs(Math.sin(t * (1 + k * 0.37)) * 0.55 + Math.sin(t * 7.1 + k) * 0.25) * (k === 2 ? 1.6 : 1)
  const timer = setInterval(() => {
    t += 0.033
    meters.forEach((m, k) => m.push(level(k), level(k) * 0.9))
    hm.push(level(1), level(3))
  }, 33)

  const fields = row(
    numberField({ value: 120, min: 20, max: 300, step: 1, format: (v) => `${v} bpm`, width: '84px', title: 'tempo: drag or click to type' }).el,
    numberField({ value: 0.5, min: 0, max: 1, step: 0.01 }).el,
    h('input', { placeholder: 'project name' }),
    h('select', {}, h('option', {}, '48 kHz'), h('option', {}, '44.1 kHz')),
    h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: true }), h('span', {}, 'public')),
    h('label', { className: 'check' }, h('input', { type: 'checkbox' }), h('span', {}, 'demo')),
  )
  const chips = row(
    h('span', { className: 'chip' }, 'synth'),
    ...TRACK_COLORS.slice(0, 4).map((c, i) => h('span', { className: 'chip', style: `--c:${c}` }, ['bass', 'keys', 'drums', 'pad'][i])),
    h('button', { className: 'chip on' }, '1/16'),
    h('span', {}, h('kbd', {}, 'space'), ' ', h('kbd', {}, '⌘'), h('kbd', {}, 'Z'), ' ', h('kbd', {}, '?')),
  )
  const menuBtn = h('button', { className: 'btn' }, icon('more'), 'menu')
  menuBtn.onclick = () => popover(menuBtn, [['rename', () => {}], ['duplicate', () => {}], ['export .mobdaw', () => {}], ['delete', () => {}]])
  const dlgBtn = h('button', { className: 'btn', onclick: () => {
    const d = h('dialog', { className: 'modal', onclose: () => d.remove() },
      h('div', { className: 'modal-head' }, h('h2', {}, 'A dialog'), iconButton('close', 'close (esc)', () => d.close())),
      h('div', { className: 'modal-body' }, h('label', { className: 'field' }, h('span', {}, 'file name'), h('input', { value: 'soggy biscuit' })), h('progress', { max: 1, value: 0.4 })),
      h('div', { className: 'modal-foot' }, h('button', { className: 'btn', onclick: () => d.close() }, 'cancel'), h('button', { className: 'btn primary' }, 'export')))
    document.body.append(d)
    d.showModal()
  } }, 'dialog')

  const swatches = row(...['--bg', '--panel', '--raise', '--line', '--line-strong', '--faint', '--dim', '--fg', '--accent', '--rec', '--ok'].map((v) =>
    h('div', { className: 'kit-sw' }, h('i', { style: `background:var(${v})` }), h('span', {}, v))),
  ...TRACK_COLORS.map((c, i) => h('div', { className: 'kit-sw' }, h('i', { style: `background:${c}` }), h('span', {}, `track ${i}`))))

  const type = h('div', { className: 'kit-type' },
    h('div', { className: 'kit-counter' }, h('span', { className: 'bars' }, '12.3.2'), h('span', { className: 'clock' }, '0:24.5')),
    h('h1', {}, 'Heading 24 / 600'), h('h2', {}, 'Heading 18 / 600'), h('h3', {}, 'Heading 15 / 500'),
    h('p', {}, 'Body 13px. Record, loop, sequence, automate and mix on a native-speed engine.'),
    h('p', { className: 'label' }, 'Label 12px, dim'), h('p', { className: 'logo' }, 'mobdaw'))

  mount(h('main', { className: 'kit' },
    h('h1', {}, 'Kit'),
    sec('Colour', swatches),
    sec('Type', type),
    sec('Icons', icons, iconsLg),
    sec('Buttons', buttons, icons2, row(tipped, menuBtn, dlgBtn)),
    sec('Segmented', seg),
    sec('Knobs', knobs),
    sec('Faders and meters', faders),
    sec('Fields', fields),
    sec('Chips and keys', chips)))
  return () => clearInterval(timer)
}
