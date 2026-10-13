// mountStudio: builds the studio layout (docs/redesign.md §3) around one Studio and mounts the views:
//   topbar / browser (left) | arrangement (+ chat) / dock / status bar
import { h } from '../dom'
import type { Session } from '../project/session'
import { chatPanel } from '../ui/chat'
import { mountArrange } from './arrange/arrange'
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
  const chat = chatPanel({ doc: s.doc, user: s.user, readOnly, onUnread: (n) => unread(n) })
  const top = mountTopbar(st, { projectName, renameProject, cloud, chat: s.local ? undefined : chat })
  unread = top.setUnread

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

  const el = h('div', { className: 'studio' },
    top.el,
    h('div', { className: 'studio-main' }, browser, h('div', { className: 'studio-centre' }, arrange.el, mixer.el, chat.el)),
    dock.el,
    statusBar)

  function layout() {
    arrange.el.hidden = st.ui.view === 'mix'
    browser.hidden = !st.ui.browserOpen
    el.classList.toggle('browser-open', st.ui.browserOpen)
  }
  const offs = [
    st.on('ui', (p) => {
      if (!('browserOpen' in p) && !('view' in p)) return
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
