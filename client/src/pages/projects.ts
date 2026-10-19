import type { Me, ProjectDetail, ProjectSummary } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { deleteProjectAudio } from '../local/audio'
import { dateOf } from '../format'
import { cloudToLocal } from '../transfer'
import { silliName } from '../projectName'
import { confirmModal } from '../theme/dialog'
import { icon } from '../theme/icons'
import { shareDialog } from '../ui/share'
import { projectTile, renameInPlace, type TileAction } from '../ui/tile'

/** A cloud project we no longer have: drop the takes this device staged for it (docs/engine.md §9.3). */
const forgetTakes = (id: string) => deleteProjectAudio(id).catch(() => {})

/** What a tile says under the name: whose it is, who it is shared with, and whether it is read-only. */
export function cloudDetails(p: ProjectSummary, d: ProjectDetail | null): string[] {
  const out: string[] = []
  if (p.role !== 'owner') out.push(`${p.ownerUsername}’s · ${p.role}`)
  else {
    const others = d ? d.members.filter((m) => m.role !== 'owner').length : 0
    out.push(others ? `shared with ${others}` : 'only you')
  }
  if (p.public) out.push('public')
  if (p.frozen) out.push(p.role === 'owner' || !p.retentionEndsAt ? 'read-only' : `read-only until ${dateOf(p.retentionEndsAt)}`)
  return [out.join(' · ')]
}

/** The account's cloud projects: owned and shared with you, and the way to start one. */
export function cloudSection(me: Me): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error', role: 'alert' })
  const status = h('p', { className: 'dim status', role: 'status' })
  const count = h('span', { className: 'sec-count num' })
  const accountRO = me.planStatus !== 'active'

  const busy = async (msg: string, fn: () => Promise<unknown>, refresh = true) => {
    err.textContent = ''
    status.textContent = msg
    try {
      await fn()
    } catch (e) {
      err.textContent = describeError(e)
    } finally {
      status.textContent = ''
    }
    if (refresh) void render()
  }

  const createLabel = h('span', {}, 'new cloud project')
  const create = h('button', {
    className: 'btn', type: 'button', disabled: accountRO,
    title: accountRO ? 'your subscription has ended' : 'start an empty project in the cloud, to share and edit together',
    onclick: () => busy('creating…', async () => {
      create.disabled = true
      const p = await api.createProject({ name: silliName() })
      location.hash = `#/project/${p.id}`
    }, false).finally(() => (create.disabled = accountRO)),
  }, icon('plus'), createLabel)

  let generation = 0
  async function render() {
    const gen = ++generation
    const projects = await api.projects()
    const details = await Promise.all(projects.map((p) => (p.role === 'owner' ? api.project(p.id).catch(() => null) : null)))
    if (gen !== generation) return
    count.textContent = projects.length ? String(projects.length) : ''
    list.replaceChildren(...projects.map((p, i) => tile(p, details[i])))
    list.hidden = !projects.length
    empty.hidden = !!projects.length
  }

  function tile(p: ProjectSummary, d: ProjectDetail | null) {
    const owner = p.role === 'owner'
    // Read-only: the account's own subscription ended, or the owner's did (the project is frozen until they resubscribe).
    const locked = accountRO || p.frozen
    const actions: TileAction[] = []
    if (owner) actions.push({ label: 'rename', icon: 'edit', disabled: locked, onclick: () =>
      renameInPlace(el, p.name, (n) => void busy('renaming…', () => api.renameProject(p.id, n))) })
    actions.push(
      { label: owner ? 'share…' : 'people…', icon: 'users', title: owner ? 'add people, change roles, or make a public link' : 'who is in this project',
        onclick: () => shareDialog({ projectId: p.id, name: p.name, me: me.username, owner, locked, public: p.public, onChange: () => void render() }) },
      { label: 'save a copy', icon: 'duplicate', disabled: accountRO, title: 'a new cloud project of your own, with the same tracks and audio',
        onclick: () => busy(`copying ${p.name}…`, () => api.copyProject(p.id)) },
      { label: 'copy to this device', icon: 'folder', title: 'copy this project and its audio into this browser, to work on it without the cloud',
        onclick: () => busy('copying to this device…', async () => {
          const lp = await cloudToLocal(p.id, me, (m) => (status.textContent = m))
          location.hash = `#/local/${lp.id}`
        }, false) },
    )
    if (owner) actions.push({ label: 'delete', icon: 'trash', danger: true, onclick: async () => {
      const others = d?.members.filter((m) => m.role !== 'owner').length ?? 0
      const yes = await confirmModal({
        title: `Delete “${p.name}”?`,
        text: `The project and its place in everyone's list are removed from the cloud${others ? `, for the ${others} other ${others === 1 ? 'person' : 'people'} in it too` : ''}. Audio stays in each owner's uploads. This cannot be undone.`,
        action: 'delete', danger: true,
      })
      if (yes) void busy('deleting…', () => api.deleteProject(p.id).then(() => forgetTakes(p.id)))
    } })
    else actions.push({ label: 'leave', icon: 'close', danger: true, onclick: async () => {
      const yes = await confirmModal({
        title: `Leave “${p.name}”?`,
        text: `It leaves your list. ${p.ownerUsername} can add you again.`,
        action: 'leave', danger: true,
      })
      if (yes) void busy('leaving…', () => api.leaveProject(p.id).then(() => forgetTakes(p.id)))
    } })
    const el: HTMLElement = projectTile({ href: `#/project/${p.id}`, name: p.name, details: cloudDetails(p, d), preview: () => api.projectPreview(p.id), actions })
    return el
  }

  const empty = h('div', { className: 'tiles-empty', hidden: true },
    h('p', {}, 'No cloud projects yet.'),
    h('p', { className: 'dim' }, 'Start one here, or move a project from this device with “upload to cloud” in its ⋯ menu. Cloud projects can be shared and edited together.'))

  const section = h('section', { className: 'home-sec', 'aria-labelledby': 'cloud-h' },
    h('div', { className: 'sec-head' }, h('h2', { id: 'cloud-h' }, 'Cloud projects'), count, h('span', { className: 'grow' }), create),
    status, err, list, empty)
  list.hidden = true
  render().catch((e) => (err.textContent = describeError(e)))
  return section
}
