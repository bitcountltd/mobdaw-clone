// A cloud project's people: who is in it and in what role. The owner can change roles, remove people and add someone;
// everyone else sees the list. Used by the project settings in the studio and by the share dialog on the home page.
import { userColor, type ProjectDetail } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { iconButton } from '../theme/controls'
import './members.css'

type Role = 'editor' | 'viewer'
const ROLE_HINT: Record<Role, string> = { editor: 'can change the project', viewer: 'can open it, read-only' }
const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

const roleSelect = (value: Role, disabled: boolean, onchange?: (role: Role) => void) => {
  const s = h('select', { disabled, 'aria-label': 'role' },
    h('option', { value: 'editor', title: ROLE_HINT.editor }, 'editor'), h('option', { value: 'viewer', title: ROLE_HINT.viewer }, 'viewer'))
  s.value = value
  if (onchange) s.onchange = () => onchange(s.value as Role)
  return s
}

/**
 * The people in a project, loaded from the server and kept current as the owner edits it. `onChange` hears the new
 * details after each change (e.g. to refresh a count); `onError` gets failures.
 */
export function peopleList(o: {
  projectId: string; me: string; owner: boolean; locked: boolean
  onChange?(d: ProjectDetail): void; onError(e: unknown): void
}): HTMLElement {
  const el = h('div', { className: 'people', 'aria-busy': 'true' }, h('p', { className: 'dim people-note' }, 'loading…'))
  const act = (fn: () => Promise<ProjectDetail>) => {
    el.setAttribute('aria-busy', 'true')
    fn().then((d) => (o.onChange?.(d), load()), (e) => (el.removeAttribute('aria-busy'), o.onError(e)))
  }

  function show(d: ProjectDetail, usernames: string[]) {
    el.removeAttribute('aria-busy')
    const canEdit = o.owner && !o.locked
    const rows = d.members.map((m) => {
      const you = m.username === o.me
      const role = m.role === 'owner' ? h('span', { className: 'dim people-role' }, 'owner')
        : canEdit ? roleSelect(m.role as Role, false, (role) => act(() => api.addMember(o.projectId, { username: m.username, role })))
        : h('span', { className: 'dim people-role', title: ROLE_HINT[m.role as Role] }, m.role)
      const remove = canEdit && m.role !== 'owner'
        ? iconButton('close', `remove ${m.username}`, () => act(() => api.removeMember(o.projectId, m.username)), 'sm people-remove') : null
      return h('div', { className: 'people-row' },
        h('span', { className: 'people-dot', style: `background:${userColor(m.username)}` }, initials(m.username)),
        h('span', { className: 'people-name' }, m.username, you ? h('span', { className: 'dim' }, ' (you)') : null),
        role, remove)
    })
    let add: HTMLElement | null = null
    if (canEdit) {
      const others = usernames.filter((u) => !d.members.some((m) => m.username === u))
      if (!others.length) add = h('p', { className: 'dim people-note' }, 'Everyone with an account is already in this project.')
      else {
        const pick = h('select', { 'aria-label': 'person to add' }, h('option', { value: '' }, 'add someone…'), ...others.map((u) => h('option', { value: u }, u)))
        const role = roleSelect('editor', false)
        const go = h('button', { className: 'btn', type: 'button', disabled: true, onclick: () => pick.value && act(() => api.addMember(o.projectId, { username: pick.value, role: role.value as Role })) }, 'add')
        pick.onchange = () => (go.disabled = !pick.value)
        add = h('div', { className: 'people-add' }, pick, role, go)
      }
    }
    el.replaceChildren(...rows, add ?? '')
  }
  const load = () =>
    Promise.all([api.project(o.projectId), o.owner ? api.users() : Promise.resolve([])])
      .then(([d, users]) => show(d, users.map((u) => u.username)), (e) => (el.removeAttribute('aria-busy'), o.onError(e)))
  void load()
  return el
}

/** A project's address, to send to someone. */
export const projectLink = (id: string) => `${location.origin}${location.pathname}#/project/${id}`
