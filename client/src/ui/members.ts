import type { Member } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'

type Role = 'editor' | 'viewer'
const roleSelect = (value: string, onchange: (role: Role) => void) => {
  const s = h('select', {}, h('option', { value: 'editor' }, 'editor'), h('option', { value: 'viewer' }, 'viewer'))
  s.value = value
  s.onchange = () => onchange(s.value as Role)
  return s
}

/**
 * A project's collaborators: one row per member (change role / remove) and a picker to share with someone new.
 * `act` runs a change, then refreshes whatever shows the list (the caller re-renders with the new members).
 */
export function memberRows(o: {
  projectId: string; members: Member[]; usernames: string[]; me: string; locked: boolean
  act(fn: () => Promise<unknown>): void
}): HTMLElement[] {
  const { projectId: id, act } = o
  const rows = o.members.filter((m) => m.role !== 'owner').map((m) =>
    h('div', { className: 'row' }, h('span', { className: 'grow' }, m.username),
      roleSelect(m.role, (role) => act(() => api.addMember(id, { username: m.username, role }))),
      h('button', { title: 'remove', disabled: o.locked, onclick: () => act(() => api.removeMember(id, m.username)) }, '\u00d7')))
  const pick = h('select', { disabled: o.locked }, h('option', { value: '' }, 'share with…'),
    ...o.usernames.filter((u) => u !== o.me && !o.members.some((m) => m.username === u)).map((u) => h('option', { value: u }, u)))
  const role = roleSelect('editor', () => {})
  pick.onchange = () => pick.value && act(() => api.addMember(id, { username: pick.value, role: role.value as Role }))
  return [...rows, h('div', { className: 'row' }, pick, role)]
}
