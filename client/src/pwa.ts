// Installable + offline: registers the service worker (built from src/sw.ts by swPlugin) and offers a reload when a
// newer build is waiting. Production builds only, and only where service workers are allowed (https, or localhost).
import { h } from './dom'
import { icon } from './theme/icons'
import './pwa.css'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Whether this page should run the service worker. */
export function swAllowed(loc: Pick<Location, 'protocol' | 'hostname'> = location, prod = import.meta.env.PROD): boolean {
  return prod && typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
    (loc.protocol === 'https:' || (loc.protocol === 'http:' && LOCAL_HOSTS.has(loc.hostname)))
}

let toastEl: HTMLElement | null = null

/** The small "update available" toast; its reload button hands over to the waiting worker. */
export function updateToast(onReload: () => void): HTMLElement {
  toastEl?.remove()
  const reload = h('button', { className: 'btn primary', onclick: () => {
    reload.disabled = true
    reload.textContent = 'reloading…'
    onReload()
  } }, 'reload')
  const el = h('div', { className: 'sw-toast', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'sw-toast-text' }, 'Update available', h('span', { className: 'dim' }, ' · a newer mobdaw is ready')),
    reload,
    h('button', { className: 'icon-btn sm', title: 'later (the update is used next time mobdaw opens)', 'aria-label': 'dismiss', onclick: () => el.remove() }, icon('close')))
  document.body.append(el)
  toastEl = el
  return el
}

export function registerServiceWorker() {
  if (!swAllowed()) return
  const sw = navigator.serviceWorker
  // relative to the page: works at '/', '/mobdaw/' and from a relative build in any folder
  const base = import.meta.env.BASE_URL
  let reloading = false
  let wanted = false // only the update button reloads (the first install also changes the controller)
  sw.addEventListener('controllerchange', () => {
    if (!wanted || reloading) return
    reloading = true
    location.reload()
  })
  const offer = (w: ServiceWorker) => {
    if (!sw.controller) return // first install: nothing older is running
    updateToast(() => {
      wanted = true
      w.postMessage({ type: 'skip-waiting' })
    })
  }
  const start = async () => {
    const reg = await sw.register(`${base}sw.js`, { scope: base })
    if (reg.waiting) offer(reg.waiting)
    reg.addEventListener('updatefound', () => {
      const w = reg.installing
      w?.addEventListener('statechange', () => w.state === 'installed' && offer(w))
    })
    // look for a new build now and then while the tab stays open
    const check = () => void reg.update().catch(() => {})
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
    setInterval(check, 60 * 60 * 1000)
  }
  const go = () => void start().catch((e) => console.warn('service worker:', e))
  if (document.readyState === 'complete') go()
  else addEventListener('load', go, { once: true })
}
