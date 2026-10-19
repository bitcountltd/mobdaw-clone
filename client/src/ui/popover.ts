import { h } from '../dom'
import { icon, type IconName } from '../theme/icons'

let closer: Event | null = null
/** The gap kept between a popover and the window's edges. */
const EDGE = 8
/** True if this event is what just closed a popover (so its click shouldn't open another). */
export const closedBy = (e: Event) => closer === e

/**
 * Show `menu` next to `anchor` (or at viewport point `at`); it closes on an outside press or Escape. A press on the
 * anchor itself that closes it also swallows the click that follows, so clicking a button again hides its menu
 * instead of re-opening it. Returns the function that closes it.
 */
/** The menu open on each anchor, and when it opened. */
const open = new WeakMap<HTMLElement, { close: () => void; at: number }>()
/**
 * How long a menu ignores presses after it opens. A quick click (a trackpad tap) can be followed within a frame or two by
 * events of the same press, or the second press of a double click: they would close the menu as it appears (or, on its
 * button, close it and swallow the next click so it seemed not to open at all).
 */
const SETTLE_MS = 180

function showMenu(anchor: HTMLElement, menu: HTMLElement, at?: [x: number, y: number]) {
  // the same button again straight away (a double click, a doubled event): the menu that just opened stays
  const prev = open.get(anchor)
  if (!at && prev && performance.now() - prev.at < SETTLE_MS * 2) return prev.close
  prev?.close()
  const opened = performance.now()
  const close = () => {
    menu.remove()
    removeEventListener('pointerdown', away, true)
    removeEventListener('keydown', esc, true)
    if (open.get(anchor)?.close === close) open.delete(anchor)
  }
  const away = (e: Event) => {
    if (menu.contains(e.target as Node)) return
    if (performance.now() - opened < SETTLE_MS) return
    closer = e
    close()
    if (at || (e as PointerEvent).button !== 0 || !anchor.contains(e.target as Node)) return
    const swallow = (c: Event) => (c.stopPropagation(), c.preventDefault(), done())
    const done = () => (removeEventListener('click', swallow, true), clearTimeout(timer))
    const timer = setTimeout(done, 1000) // (the press may never become a click)
    addEventListener('click', swallow, true)
  }
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
  const r = anchor.getBoundingClientRect()
  // measured at the left edge first (so its width is not squeezed by the window's right edge), then placed
  menu.style.left = '0px'
  menu.style.top = '0px'
  menu.style.maxWidth = `${innerWidth - 2 * EDGE}px`
  document.body.append(menu)
  const m = menu.getBoundingClientRect()
  // anchored in the right half: line the menu up with the anchor's right edge instead
  let x = at ? at[0] : r.left + r.width / 2 > innerWidth / 2 ? r.right - m.width : r.left
  // keep it on screen, a little in from the edges (the chat sits at the right edge)
  x = Math.max(EDGE, Math.min(x, innerWidth - m.width - EDGE))
  let y: number
  if (at) {
    y = at[1]
    if (y + m.height > innerHeight - EDGE) y = Math.max(EDGE, innerHeight - m.height - EDGE)
  } else {
    // below the anchor, else above it; never over it, or a second click on the anchor would land on an entry. Taller than
    // either side: on the roomier side, scrolling.
    const below = innerHeight - EDGE - (r.bottom + 4)
    const above = r.top - 4 - EDGE
    if (m.height <= below) y = r.bottom + 4
    else if (m.height <= above) y = r.top - 4 - m.height
    else {
      const room = Math.max(below, above, 80)
      menu.style.maxHeight = `${room}px`
      menu.style.overflowY = 'auto'
      y = below >= above ? r.bottom + 4 : r.top - 4 - room
    }
  }
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  addEventListener('pointerdown', away, true)
  addEventListener('keydown', esc, true)
  // a press already under way when it opened (the second half of a double click or tap) doesn't pick an entry
  menu.addEventListener('click', (e) => { if (performance.now() - opened < 250) (e.stopPropagation(), e.preventDefault()) }, true)
  open.set(anchor, { close, at: opened })
  return close
}

/** A menu entry: a `[label, run]` pair, a richer item, or `'sep'` for a divider. */
export type MenuItem =
  | [label: string, run: () => void]
  | { label: string; run: () => void; icon?: IconName; danger?: boolean; disabled?: boolean; title?: string; hint?: string }
  | 'sep'

/** A small menu next to `anchor` (or at viewport point `at`); closes on pick, outside click or Escape. Arrow keys move. */
export function popover(anchor: HTMLElement, items: MenuItem[], at?: [x: number, y: number]) {
  const menu = h('div', { className: 'popover', role: 'menu' },
    ...items.map((it) => {
      if (it === 'sep') return h('div', { className: 'sep', role: 'separator' })
      const o = Array.isArray(it) ? { label: it[0], run: it[1] } as Exclude<MenuItem, 'sep' | unknown[]> : it
      const b = h('button', { className: o.danger ? 'danger' : undefined, role: 'menuitem', disabled: o.disabled, title: o.title, onclick: () => (close(), o.run()) })
      if (o.icon) b.append(icon(o.icon))
      b.append(h('span', {}, o.label))
      if (o.hint) b.append(h('span', { className: 'kbd-hint' }, o.hint))
      return b
    }))
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d || !btns.length) return
    e.preventDefault()
    btns[(i + d + btns.length) % btns.length].focus()
  })
  const close = showMenu(anchor, menu, at)
  // keyboard users land on the first entry
  if (anchor.matches(':focus-visible')) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  return close
}

/** Like `popover`, but with arbitrary content. Returns the function that closes it again. */
export function popoverPanel(anchor: HTMLElement, content: HTMLElement) {
  return showMenu(anchor, h('div', { className: 'popover panel' }, content))
}

/** Right-click on `el` offers a delete entry (after any `extra` ones). `run` is skipped (no menu) when `enabled` says no. */
export function deleteMenu(el: HTMLElement, label: string, run: () => void, enabled: () => boolean = () => true, extra: MenuItem[] = []) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation() // not the lane's background menu underneath
    if (enabled()) popover(el, [...extra, [label, run]], [e.clientX, e.clientY])
  })
}
