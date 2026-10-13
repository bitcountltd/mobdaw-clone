// Keyboard shortcuts: one keydown dispatcher per studio, fed by `registerKeys` (any module can add bindings), and the
// list the ? overlay (help.ts) shows. Events in text fields, selects and contenteditable never reach it, and dialogs stop
// their keys (theme/dialog.ts).
//
// A binding names keys by `KeyboardEvent.key` (case-insensitive: 'z', 'space', 'escape', 'delete', '?', '=') or by
// physical `code` ('KeyA', 'Semicolon'), which the computer keyboard instrument uses so it plays the same keys on any
// layout. `mod` is ⌘ on a Mac and ctrl elsewhere. Shift must match exactly, except for a symbol key with no `shift` given
// ('?' needs shift on most layouts, '+' too).
//
// Dispatch order: higher `priority` first, then the most recently registered. The first binding whose keys and modifiers
// match and whose `when` allows it handles the event (and prevents the default). A held key's repeats run it again only
// when `repeat` is set, and are swallowed otherwise.
import { clipsMap, deleteClip, deleteNote, deletePad, splitClip, tracksMap } from '@mobdaw/shared'
import { ACTIONS } from '../audio/pedal'
import type { Studio } from './studio'

export type KeyGroup = 'Transport' | 'Editing' | 'View' | 'Keyboard instrument' | (string & {})
export type Mods = { mod?: boolean; shift?: boolean; alt?: boolean }
export type KeyBinding = {
  /** One key or several (by `KeyboardEvent.key`, lower case or a name such as 'space', 'escape', 'arrowleft'). */
  key?: string | string[]
  /** Physical keys instead (`KeyboardEvent.code`). */
  code?: string | string[]
  mods?: Mods
  /** Only while this holds (checked at the time of the key). */
  when?: () => boolean
  run: (e: KeyboardEvent) => void
  /** What it does, as the ? overlay lists it ("play / pause"). */
  label: string
  group: KeyGroup
  /** How the overlay writes the keys, when the key names don't read well ("A – ;"). */
  display?: string
  /** Run again on auto-repeat. */
  repeat?: boolean
  /** Leave the default action alone (e.g. let the browser have the key too). */
  passive?: boolean
  priority?: number
  /** Not listed in the overlay. */
  hidden?: boolean
  /** Works in a view-only project (transport and view keys). */
  readOnly?: boolean
}
type Entry = KeyBinding & { seq: number }

export const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent)

/** The bits of a KeyboardEvent matching needs (so tests can pass plain objects). */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>

const NAMES: Record<string, string> = { ' ': 'space', spacebar: 'space', esc: 'escape', del: 'delete', left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown' }
const norm = (k: string) => { const l = k.toLowerCase(); return NAMES[l] ?? l }
const list = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v])
/** A single printable character that is not a letter or digit ('?', '=', '[', ';'). */
const isSymbol = (k: string) => k.length === 1 && !/[a-z0-9]/i.test(k)

/** Whether `e` presses one of the binding's keys with its modifiers (`mac`: mod means ⌘, else ctrl). */
export function matches(b: Pick<KeyBinding, 'key' | 'code' | 'mods'>, e: KeyLike, mac = IS_MAC): boolean {
  const m = b.mods ?? {}
  const mod = mac ? e.metaKey : e.ctrlKey
  const stray = mac ? e.ctrlKey : e.metaKey // the other one: never part of a shortcut here
  if (!!m.mod !== mod || stray || !!m.alt !== e.altKey) return false
  const keys = list(b.key).map(norm), codes = list(b.code)
  const ek = norm(e.key)
  // Letters and digits by their key, or by their physical key when alt/shift or the layout changed the character.
  const byCode = /^Key[A-Z]$|^Digit[0-9]$/.test(e.code) ? e.code.slice(-1).toLowerCase() : null
  const hitKey = keys.some((k) => k === ek || (byCode != null && k === byCode && !isSymbol(k)))
  const hitCode = codes.includes(e.code)
  if (!hitKey && !hitCode) return false
  const symbol = hitKey && !hitCode && isSymbol(ek)
  if (m.shift === undefined && symbol) return true
  return !!m.shift === e.shiftKey
}

const KEY_LABEL: Record<string, string> = {
  space: 'space', escape: 'esc', delete: 'delete', backspace: '⌫', enter: '↵', tab: 'tab', home: 'home', end: 'end',
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
}
const CODE_LABEL = (c: string) => c.replace(/^Key|^Digit/, '').replace('Semicolon', ';').replace('Quote', "'").replace('Comma', ',').replace('Period', '.')
/** The binding's key chords for display, e.g. ['⌘', '⇧', 'Z']. One entry per alternative key. */
export function chords(b: Pick<KeyBinding, 'key' | 'code' | 'mods' | 'display'>, mac = IS_MAC): string[][] {
  const m = b.mods ?? {}
  const pre = [...(m.mod ? [mac ? '⌘' : 'ctrl'] : []), ...(m.alt ? [mac ? '⌥' : 'alt'] : []), ...(m.shift ? ['⇧'] : [])]
  if (b.display) return [[...pre, b.display]]
  const keys = [...list(b.key).map((k) => KEY_LABEL[norm(k)] ?? (k.length === 1 ? k.toUpperCase() : k)), ...list(b.code).map(CODE_LABEL)]
  return keys.map((k) => [...pre, k])
}
/** "⌘⇧Z" style text for a tooltip. */
export const shortcutText = (b: Pick<KeyBinding, 'key' | 'code' | 'mods' | 'display'>, mac = IS_MAC) =>
  chords(b, mac).map((c) => c.join(mac ? '' : '+')).join(' / ')

/** Pick the binding for `e` from `entries` (pure: tests drive it). */
export function pick<T extends Entry>(entries: T[], e: KeyLike, mac = IS_MAC, readOnly = false): T | null {
  const order = [...entries].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.seq - a.seq)
  for (const b of order) {
    if (readOnly && !b.readOnly) continue
    if (!matches(b, e, mac)) continue
    if (b.when && !b.when()) continue
    return b
  }
  return null
}

// --- the registry, one per studio
type Registry = { entries: Entry[]; seq: number; listeners: Set<() => void> }
const registries = new WeakMap<Studio, Registry>()
function reg(st: Studio): Registry {
  let r = registries.get(st)
  if (!r) registries.set(st, (r = { entries: [], seq: 0, listeners: new Set() }))
  return r
}

/** Add shortcuts (before or after `mountKeys`). Returns the function that removes them again. */
export function registerKeys(st: Studio, bindings: KeyBinding[]): () => void {
  const r = reg(st)
  const added = bindings.map((b) => ({ ...b, seq: r.seq++ }))
  r.entries.push(...added)
  r.listeners.forEach((f) => f())
  return () => {
    r.entries = r.entries.filter((e) => !added.includes(e))
    r.listeners.forEach((f) => f())
  }
}
/** Every registered binding (for the overlay), in registration order. */
export const registeredKeys = (st: Studio): readonly KeyBinding[] => reg(st).entries
/** Called when bindings are added or removed. */
export function onKeysChanged(st: Studio, f: () => void) {
  const r = reg(st)
  r.listeners.add(f)
  return () => void r.listeners.delete(f)
}

/** Keys typed into a field are text, not shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable || (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox')
}

export const ZOOM_MIN = 10, ZOOM_MAX = 800

/** The studio's own shortcuts and the dispatcher. */
export function mountKeys(st: Studio) {
  const { doc, undo } = st
  /** The clips not on a track someone is recording on. */
  const unlocked = (ids: string[]) => ids.filter((id) => !st.locks.has(String(clipsMap(doc).get(id)?.get('trackId'))))
  /** Source clips (on a soundscape's source lane) have their own time axis: the playhead means nothing there. */
  const onSource = (id: string) => tracksMap(doc).get(String(clipsMap(doc).get(id)?.get('trackId')))?.get('kind') === 'soundscape'
  const zoom = (f: number) => st.setUi({ pps: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.ui.pps * f)) })
  const help = () => window.dispatchEvent(new Event('mobdaw:help'))

  const off = registerKeys(st, [
    // transport
    { key: 'space', run: () => st.toggle(), label: 'play / stop', group: 'Transport', readOnly: true },
    { key: 'space', mods: { shift: true }, run: () => void st.toggleRecord(), label: 'record', group: 'Transport' },
    { key: 'enter', run: () => st.rewind(), label: 'back to the start', group: 'Transport', readOnly: true },
    { key: ['1', '2', '3', '4'], when: () => st.pedal.on, run: (e) => st.pedal.press(ACTIONS[Number(e.key) - 1], e.timeStamp), label: 'loop pedal actions (pedal mode)', group: 'Transport', display: '1 – 4' },
    // editing
    { key: 'z', mods: { mod: true }, run: () => undo.undo(), label: 'undo', group: 'Editing', repeat: true },
    { key: 'z', mods: { mod: true, shift: true }, run: () => undo.redo(), label: 'redo', group: 'Editing', repeat: true },
    ...(IS_MAC ? [] : [{ key: 'y', mods: { mod: true }, run: () => undo.redo(), label: 'redo', group: 'Editing', repeat: true, hidden: true } satisfies KeyBinding]),
    { key: 's', run: () => {
      const at = Math.round(st.position())
      doc.transact(() => unlocked(st.ui.selection).filter((id) => !onSource(id)).forEach((id) => splitClip(doc, id, at)))
    }, label: 'split at the playhead', group: 'Editing' },
    { key: ['delete', 'backspace'], run: () => {
      const { ui } = st
      if (ui.note) {
        deleteNote(doc, ui.note)
        st.setUi({ note: null })
      } else if (ui.pad) {
        deletePad(doc, ui.pad)
        st.setUi({ pad: null })
      } else {
        doc.transact(() => unlocked(ui.selection).forEach((id) => deleteClip(doc, id)))
        st.select([])
      }
    }, label: 'delete the selection', group: 'Editing' },
    { key: 'escape', when: () => !!(st.ui.editing || st.ui.looperArm || st.ui.pad || st.ui.note),
      run: () => st.setUi({ editing: null, note: null, looperArm: null, pad: null }), label: 'close the editor / let go', group: 'Editing', readOnly: true },
    // view
    { key: 'b', run: () => st.setUi({ browserOpen: !st.ui.browserOpen }), label: 'browser', group: 'View', readOnly: true },
    { key: 'd', run: () => st.setUi({ dock: { ...st.ui.dock, open: !st.ui.dock.open } }), label: 'dock', group: 'View', readOnly: true },
    { key: ['=', '+'], run: () => zoom(1.5), label: 'zoom in', group: 'View', repeat: true, readOnly: true },
    { key: '-', run: () => zoom(1 / 1.5), label: 'zoom out', group: 'View', repeat: true, readOnly: true },
    { key: 'f', run: () => st.setUi({ follow: !st.ui.follow }), label: 'follow the playhead', group: 'View', readOnly: true },
    { key: '?', run: help, label: 'this list', group: 'View', readOnly: true },
  ])

  const key = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || isTyping(e.target)) return
    const b = pick(reg(st).entries, e, IS_MAC, st.readOnly)
    if (!b) return
    if (!b.passive) e.preventDefault()
    if (e.repeat && !b.repeat) return
    b.run(e)
  }
  addEventListener('keydown', key)
  return { destroy: () => (off(), removeEventListener('keydown', key)) }
}
