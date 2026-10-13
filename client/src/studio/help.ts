// The ? overlay: every registered shortcut, grouped, plus a few tips. Opened by ? or by a `mobdaw:help` window event
// (the top bar's help button); ? or esc closes it.
import { h } from '../dom'
import { modal, type Modal } from '../theme/dialog'
import { chords, registeredKeys, type KeyBinding } from './keys'
import type { Studio } from './studio'
import './help.css'

const ORDER = ['Transport', 'Editing', 'View', 'Keyboard instrument']
const TIPS = [
  'Drag a sound from the browser onto empty space below the tracks to make a new track with it.',
  'Hold alt (or ctrl) while dragging a clip to place it off the grid.',
  'Turn on the computer keyboard (⇧K), select a MIDI track and press record (⇧space) to record what you play.',
  'A MIDI keyboard plays the selected MIDI track as soon as the browser is allowed to use MIDI.',
]

/** Bindings by group, in the overlay's order; bindings with the same label in a group share a row. */
export function groupKeys(list: readonly KeyBinding[]): [string, { label: string; chords: string[][] }[]][] {
  const groups = new Map<string, Map<string, string[][]>>()
  for (const b of list) {
    if (b.hidden) continue
    const g = groups.get(b.group) ?? new Map<string, string[][]>()
    groups.set(b.group, g)
    g.set(b.label, [...(g.get(b.label) ?? []), ...chords(b)])
  }
  const rank = (g: string) => (ORDER.includes(g) ? ORDER.indexOf(g) : ORDER.length)
  return [...groups].sort((a, b) => rank(a[0]) - rank(b[0])).map(([g, rows]) => [g, [...rows].map(([label, c]) => ({ label, chords: c }))])
}

/** One chord as keycaps; a display such as "Z / X" or "A – '" keeps its separators as text. */
const chordEl = (c: string[]) => h('span', { className: 'help-chord' },
  ...c.flatMap((k) => (k.includes(' ') ? k.split(' ') : [k])).map((k) => (k === '/' || k === '–' ? h('span', { className: 'help-or' }, k) : h('kbd', {}, k))))

export function mountHelp(st: Studio) {
  let open: Modal | null = null
  function show() {
    if (open) return open.close()
    const groups = groupKeys(registeredKeys(st)).map(([g, rows]) =>
      h('section', { className: 'help-group' }, h('h3', {}, g),
        h('dl', {}, ...rows.flatMap((r) => [
          h('dt', {}, r.label),
          h('dd', {}, ...r.chords.flatMap((c, i) => (i ? [h('span', { className: 'help-or' }, 'or'), chordEl(c)] : [chordEl(c)]))),
        ]))))
    const tips = h('ul', { className: 'help-tips' }, ...TIPS.map((t) => h('li', {}, t)))
    open = modal({ title: 'Keyboard shortcuts', className: 'help-modal', body: [h('div', { className: 'help-grid' }, ...groups), tips], onClose: () => (open = null) })
    open.foot.remove()
    open.body.tabIndex = -1
    open.body.focus() // (not the close button: no focus ring on open)
    open.el.addEventListener('keydown', (e) => { if (e.key === '?') { e.preventDefault(); open?.close() } })
  }
  addEventListener('mobdaw:help', show)
  return { show, destroy: () => (removeEventListener('mobdaw:help', show), open?.close()) }
}
