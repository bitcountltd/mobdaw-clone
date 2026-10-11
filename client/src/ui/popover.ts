import { h } from '../dom'

let closer: Event | null = null
/** True if this event is what just closed a popover (so its click shouldn't open another). */
export const closedBy = (e: Event) => closer === e

/**
 * Show `menu` next to `anchor` (or at viewport point `at`); it closes on an outside press or Escape. A press on the
 * anchor itself that closes it also swallows the click that follows, so clicking a button again hides its menu
 * instead of re-opening it. Returns the function that closes it.
 */
function showMenu(anchor: HTMLElement, menu: HTMLElement, at?: [x: number, y: number]) {
  const close = () => {
    menu.remove()
    removeEventListener('pointerdown', away, true)
    removeEventListener('keydown', esc, true)
  }
  const away = (e: Event) => {
    if (menu.contains(e.target as Node)) return
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
  menu.style.left = `${at ? at[0] : r.left}px`
  menu.style.top = `${at ? at[1] : r.bottom + 2}px`
  document.body.append(menu)
  const m = menu.getBoundingClientRect() // keep it on screen (the chat sits at the right edge)
  if (m.right > innerWidth) menu.style.left = `${Math.max(0, innerWidth - m.width)}px`
  if (m.bottom > innerHeight) menu.style.top = `${Math.max(0, innerHeight - m.height)}px`
  addEventListener('pointerdown', away, true)
  addEventListener('keydown', esc, true)
  return close
}

/** A small menu next to `anchor` (or at viewport point `at`); closes on pick, outside click or Escape. */
export function popover(anchor: HTMLElement, items: [label: string, run: () => void][], at?: [x: number, y: number]) {
  const menu = h('div', { className: 'popover' },
    ...items.map(([label, run]) => h('button', { onclick: () => (close(), run()) }, label)))
  const close = showMenu(anchor, menu, at)
}

/** Like `popover`, but with arbitrary content. Returns the function that closes it again. */
export function popoverPanel(anchor: HTMLElement, content: HTMLElement) {
  return showMenu(anchor, h('div', { className: 'popover panel' }, content))
}

/** Right-click on `el` offers a delete entry (after any `extra` ones). `run` is skipped (no menu) when `enabled` says no. */
export function deleteMenu(el: HTMLElement, label: string, run: () => void, enabled: () => boolean = () => true, extra: [string, () => void][] = []) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation() // not the lane's background menu underneath
    if (enabled()) popover(el, [...extra, [label, run]], [e.clientX, e.clientY])
  })
}
