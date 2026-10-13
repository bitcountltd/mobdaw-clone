import { h, mount } from '../dom'
import { homeLink } from '../router'
import { getLocal, renameLocal } from '../local/projects'
import { openLocalSession } from '../local/session'
import { mountStudio } from '../studio/shell'

/** The editor for a project on this device. */
export function localProjectPage(id: string) {
  const project = getLocal(id)
  if (!project) {
    mount(h('main', { className: 'center' }, h('p', { className: 'error' }, 'that project is not on this device.'), h('a', homeLink, 'back')))
    return
  }
  const session = openLocalSession(id)
  const tl = mountStudio(session, project.name, false, (n) => renameLocal(id, n))
  mount(tl.el)
  void session.storageFailed.then((failed) => {
    if (failed && tl.el.isConnected) tl.el.prepend(h('p', { className: 'banner', role: 'alert' },
      "This browser is blocking storage, so changes won't be saved. Export the project to keep it."))
  })
  return () => {
    tl.destroy()
    session.destroy()
  }
}
