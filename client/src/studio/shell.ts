// mountStudio: builds the studio layout (docs/redesign.md §3) around one Studio and mounts the views:
//   topbar / browser (left) | arrangement (+ chat) / dock / status bar
import { h } from '../dom'
import type { Session } from '../project/session'
import { chatPanel } from '../ui/chat'
import { mountArrange } from './arrange/arrange'
import { setNarrowHeader } from './arrange/lanes'
import { mountDock } from './dock/dock'
import { mountBrowser } from './browser/browser'
import { mountHelp } from './help'
import { mountKeys } from './keys'
import { mountMixer } from './mixer/mixer'
import { mountQwerty } from './qwerty'
import { mountStatusbar } from './statusbar'
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
  let chatOpened = (_open: boolean) => {}
  const chat = chatPanel({ doc: s.doc, user: s.user, readOnly, onUnread: (n) => unread(n), onOpenChange: (o) => chatOpened(o) })
  // (watchers, in through a public link, don't read the collaborators' chat)
  const top = mountTopbar(st, { projectName, renameProject, cloud, chat: s.local || s.watching ? undefined : chat })
  unread = top.setUnread
  chatOpened = (o) => {
    top.chatOpened(o)
    window.dispatchEvent(new Event('resize')) // the arrangement's width changed
  }

  // The browser of sounds, instruments, effects and project audio (browser/browser.ts), in the left panel.
  const qwerty = mountQwerty(st) // (before the browser, which shows its state)
  const help = mountHelp(st)
  const browserView = mountBrowser(st)
  const browserMount = h('div', { className: 'browser-mount' }, browserView.el)
  const browser = h('aside', { className: 'studio-browser' }, browserMount)

  const arrange = mountArrange(st)
  const mixer = mountMixer(st) // shown in the arrangement's place while ui.view is 'mix'
  const dock = mountDock(st)
  const keys = mountKeys(st)

  const status = mountStatusbar(st, () => el)
  const statusBar = status.el

  // A visually hidden link, first in the tab order: straight to the tracks (past the top bar and the browser).
  const skip = h('a', { className: 'sr-only skip-link', href: '#', onclick: (e: MouseEvent) => {
    e.preventDefault()
    const head = arrange.el.querySelector<HTMLElement>('.lanes .track-head') ?? arrange.el.querySelector<HTMLElement>('.add-track, .arr-empty button')
    if (head && !head.matches('button')) head.tabIndex = -1
    ;(head ?? arrange.el).focus()
  } }, 'Skip to tracks')
  const el = h('div', { className: 'studio' },
    skip,
    top.el,
    h('div', { className: 'studio-main' }, browser, h('div', { className: 'studio-centre' }, arrange.el, mixer.el, chat.el)),
    dock.el,
    statusBar)

  function layout() {
    arrange.el.hidden = st.ui.view === 'mix'
    browser.hidden = !st.ui.browserOpen
    el.classList.toggle('browser-open', st.ui.browserOpen)
    el.classList.toggle('narrow', st.ui.narrow)
  }
  // Under 600px wide: slim track headers (.studio.narrow; the lanes' header column follows HEADER).
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const w = el.clientWidth || innerWidth
    const narrow = w > 0 && w < 600
    if (narrow === st.ui.narrow) return
    setNarrowHeader(narrow)
    st.setUi({ narrow })
  }) : null
  ro?.observe(el)
  const offs = [
    st.on('ui', (p) => {
      if (!('browserOpen' in p) && !('view' in p) && !('narrow' in p)) return
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
      ro?.disconnect()
      keys.destroy()
      qwerty.destroy()
      help.destroy()
      browserView.destroy()
      top.destroy()
      status.destroy()
      arrange.destroy()
      dock.destroy()
      mixer.destroy()
      chat.destroy()
      st.destroy()
    },
  }
}
