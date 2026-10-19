import type { Me } from '@mobdaw/shared'
import { api, ApiError } from '../api'
import { h, mount } from '../dom'
import { go, homeLink } from '../router'
import { mountStudio } from '../studio/shell'
import { openSession } from './session'
import { watchSync } from './syncState'

/** The editor for a cloud project. `me` is null for a signed-out visitor, who gets a public project read-only. */
export function projectPage(me: Me | null, id: string) {
  let cleanup = () => {}
  let dead = false
  api.project(id).then((p) => {
    if (dead) return
    // Not a collaborator: signed out, or in only because the project is public.
    const watching = !me || (p.role === 'viewer' && !p.members.some((m) => m.username === me.username))
    const session = openSession(id, me ?? { id: null, username: 'guest' }, watching)
    const why = !me ? 'a public project: sign in and save a copy to make your own'
      : me.planStatus !== 'active' ? 'your subscription has ended, so your cloud projects are read-only'
      : p.frozen ? `${p.ownerUsername}'s subscription has ended, so this project is read-only for now`
      : p.role === 'viewer' ? (watching ? 'a public project: save a copy (project settings) to make your own' : 'you are a viewer in this project: the owner can make you an editor')
      : undefined
    // Viewers can't edit; neither can anyone while the account (or the project's owner) is read-only.
    const tl = mountStudio(session, p.name, !me || p.role === 'viewer' || p.frozen || me.planStatus !== 'active',
      me && p.role === 'owner' && !p.frozen && me.planStatus === 'active' ? (n) => api.renameProject(id, n) : undefined,
      { projectId: id, me: me?.username ?? '', role: p.role, member: !watching, owner: p.role === 'owner', locked: p.frozen || !me || me.planStatus !== 'active', public: p.public, admin: !!me?.isAdmin, demo: p.demo, why })
    mount(tl.el)
    // The server closes our connection when access changes (removed, role changed, project deleted).
    const lost = (e?: unknown) => {
      if (dead) return
      // signed out meanwhile (the session expired, or the server's secret changed): sign in again, then come back
      const signedOut = !!me && e instanceof ApiError && e.status === 401
      mount(h('main', { className: 'center' }, h('p', {}, signedOut ? 'you were signed out. sign in again to keep working on this project.'
        : 'this project was deleted, or you no longer have access.')))
      setTimeout(() => dead || go(signedOut ? '/login' : '/'), 2000)
    }
    // (authentication also fails when the account was signed out: ask the API which it is)
    session.provider!.on('authenticationFailed', () => api.project(id).then(() => lost(), lost))
    session.provider!.on('close', ({ event }: { event: { reason?: string } }) => {
      if (event.reason === 'access_changed') api.project(id).then(() => location.reload(), lost)
    })
    // Edits made while the connection is down live only in this tab until it reconnects: ask before closing it.
    let pending = false
    const offSync = watchSync(session, (state, unsynced) => (pending = state === 'saving' || (state === 'offline' && unsynced > 0)))
    const onLeave = (e: BeforeUnloadEvent) => { if (pending && !watching) e.preventDefault() }
    addEventListener('beforeunload', onLeave)
    cleanup = () => {
      offSync()
      removeEventListener('beforeunload', onLeave)
      tl.destroy()
      session.destroy()
    }
  }, (e) => {
    if (dead) return
    if (!me && e instanceof ApiError && (e.status === 401 || e.status === 404)) return go('/login') // not public: sign in
    mount(h('main', { className: 'center' }, h('p', { className: 'error' }, 'project not found.'), h('a', homeLink, 'back')))
  })
  return () => {
    dead = true
    cleanup()
  }
}
