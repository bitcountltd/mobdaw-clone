// mountStudio: builds the studio layout (docs/redesign.md §3) around one Studio and mounts the views:
//   topbar / browser (left) | arrangement (+ chat) / dock / status bar
import { h } from '../dom'
import type { Session } from '../project/session'
import { chatPanel } from '../ui/chat'
import { mountArrange } from './arrange/arrange'
import { mountDock } from './dock/dock'
import { mountKeys } from './keys'
import { Studio } from './studio'
import { mountTopbar, type Cloud } from './topbar'
import './studio.css'

/**
 * The editor for one project. The project's name in the top bar opens its settings; `renameProject`, when given, lets
 * them change the name (it saves it). `cloud` is set for server projects.
 */
export function mountStudio(s: Session, projectName: string, readOnly = false, renameProject?: (name: string) => Promise<unknown> | void, cloud?: Cloud) {
  const st = new Studio(s, readOnly)
  let unread = (_n: number) => {}
  const chat = chatPanel({ doc: s.doc, user: s.user, readOnly, onUnread: (n) => unread(n) })
  const top = mountTopbar(st, { projectName, renameProject, cloud, chat: s.local ? undefined : chat })
  unread = top.setUnread

  // The browser of sounds, instruments, effects and project audio (browser/browser.ts, built separately): this panel
  // is its mount point. Replace the placeholder with `mountBrowser(st).el`.
  const browserMount = h('div', { className: 'browser-mount' }, h('h2', { className: 'browser-title' }, 'browser'))
  const browser = h('aside', { className: 'studio-browser' }, browserMount)

  const arrange = mountArrange(st)
  const dock = mountDock(st)
  const keys = mountKeys(st)

  const statusText = h('span', { className: 'status-text' })
  const statusBar = h('footer', { className: 'studio-status' }, statusText, h('span', { className: 'grow' }),
    readOnly ? h('span', { className: 'dim' }, 'view only') : null,
    s.local ? h('span', { className: 'dim', title: 'saved in this browser, on this device' }, 'saved on this device') : null)

  const el = h('div', { className: 'studio' },
    top.el,
    h('div', { className: 'studio-main' }, browser, h('div', { className: 'studio-centre' }, arrange.el, chat.el)),
    dock.el,
    statusBar)

  function layout() {
    browser.hidden = !st.ui.browserOpen
    el.classList.toggle('browser-open', st.ui.browserOpen)
  }
  const offs = [
    st.on('status', (t) => (statusText.textContent = t)),
    st.on('ui', (p) => {
      if (!('browserOpen' in p)) return
      layout()
      window.dispatchEvent(new Event('resize')) // the arrangement's width changed
    }),
  ]
  layout()
  void s.synced.then(() => chat.markSeen())

  return {
    el,
    /** The browser panel's mount point. */
    browserMount,
    studio: st,
    destroy() {
      offs.forEach((f) => f())
      keys.destroy()
      top.destroy()
      arrange.destroy()
      dock.destroy()
      chat.destroy()
      st.destroy()
    },
  }
}
