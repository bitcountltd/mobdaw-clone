// The ? overlay: every registered shortcut, grouped, plus a few tips. Opened by ? or by a `mobdaw:help` window event
// (the top bar's help button); ? or esc closes it.
import { h } from '../dom'
import { modal, type Modal } from '../theme/dialog'
import { chords, registeredKeys, type KeyBinding } from './keys'
import type { Studio } from './studio'
import './help.css'

const ORDER = ['Transport', 'Editing', 'View', 'Keyboard instrument']
/** Headings as the overlay shows them. */
const HEADING: Record<string, string> = { 'Keyboard instrument': 'Keys on (⇧K)' }
const TIPS = [
  'Drag a sound from the browser onto the empty space below the tracks to make a new track with it.',
  'Hold alt (or ctrl) while dragging a clip to place it off the grid.',
  'Turn on keys (⇧K), click an instrument track and press record (⇧space) to record what you play.',
  'A MIDI keyboard plays the selected instrument track once the browser is allowed to use MIDI.',
]
/** The letter shortcuts the keyboard instrument takes over while it is on (its keys are physical codes such as 'KeyS'). */
export function keysTakenOver(list: readonly KeyBinding[]): string[] {
  const inst = list.filter((b) => b.group === 'Keyboard instrument' && b.when)
  const codes = new Set(inst.flatMap((b) => (b.code == null ? [] : Array.isArray(b.code) ? b.code : [b.code])))
  const letters = new Set([...codes].filter((c) => /^Key[A-Z]$/.test(c)).map((c) => c.slice(3).toLowerCase()))
  const out = new Set<string>()
  for (const b of list) {
    if (b.group === 'Keyboard instrument' || b.hidden || b.mods?.mod || b.mods?.alt) continue
    for (const k of b.key == null ? [] : Array.isArray(b.key) ? b.key : [b.key]) if (letters.has(k.toLowerCase())) out.add(k.toUpperCase())
  }
  return [...out].sort()
}

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
    const all = registeredKeys(st)
    const taken = keysTakenOver(all)
    const groups = groupKeys(all).map(([g, rows]) =>
      h('section', { className: 'help-group' }, h('h3', {}, HEADING[g] ?? g),
        g === 'Keyboard instrument' && taken.length
          ? h('p', { className: 'help-note' }, `While keys are on, these replace ${taken.slice(0, -1).join(', ')}${taken.length > 1 ? ' and ' : ''}${taken[taken.length - 1]}.`)
          : null,
        h('dl', {}, ...rows.flatMap((r) => [
          h('dt', {}, r.label),
          h('dd', {}, ...r.chords.flatMap((c, i) => (i ? [h('span', { className: 'help-or' }, 'or'), chordEl(c)] : [chordEl(c)]))),
        ]))))
    const tips = h('ul', { className: 'help-tips' }, ...TIPS.map((t) => h('li', {}, t)))
    open = modal({ title: 'Keyboard shortcuts', className: 'help-modal', body: [h('div', { className: 'help-grid' }, ...groups), tips], onClose: () => (open = null) })
    open.foot.remove()
    open.body.tabIndex = -1
    open.body.focus({ preventScroll: true }) // (not the close button: no focus ring on open)
    open.body.scrollTop = 0
    open.el.addEventListener('keydown', (e) => { if (e.key === '?') { e.preventDefault(); open?.close() } })
  }
  addEventListener('mobdaw:help', show)
  return { show, destroy: () => (removeEventListener('mobdaw:help', show), open?.close()) }
}
