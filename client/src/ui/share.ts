// Sharing a cloud project: the people in it (and their roles), and the public read-only link.
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { modal } from '../theme/dialog'
import { peopleList, projectLink } from './members'

/** The link row: the address, and a button that copies it. */
export function linkRow(id: string): HTMLElement {
  const url = projectLink(id)
  const field = h('input', { readOnly: true, value: url, 'aria-label': 'project link', onclick: () => field.select() })
  const copy = h('button', { className: 'btn', type: 'button', onclick: () => {
    navigator.clipboard?.writeText(url).then(() => {
      copy.textContent = 'copied'
      setTimeout(() => (copy.textContent = 'copy link'), 1500)
    }, () => field.select())
  } }, 'copy link')
  return h('div', { className: 'share-link' }, field, copy)
}

export function shareDialog(o: {
  projectId: string; name: string; me: string; owner: boolean; locked: boolean; public: boolean
  onPublic?(v: boolean): void; onChange?(): void
}) {
  const err = h('p', { className: 'error', role: 'alert' })
  const fail = (e: unknown) => (err.textContent = describeError(e))
  const pub = h('input', { type: 'checkbox', checked: o.public, disabled: !o.owner || o.locked })
  const link = linkRow(o.projectId)
  const note = () => h('p', { className: 'dim people-note' }, pub.checked
    ? 'Anyone with the link can open the project and listen, read-only, without an account.'
    : 'Only the people above can open it. Send them the link.')
  let noteEl = note()
  pub.onchange = () => {
    const v = pub.checked
    api.setProjectPublic(o.projectId, v).then(() => {
      err.textContent = ''
      noteEl.replaceWith((noteEl = note()))
      o.onPublic?.(v)
      o.onChange?.()
    }, (e) => ((pub.checked = !v), fail(e)))
  }
  const m = modal({
    title: `Share “${o.name}”`,
    className: 'share-dialog',
    body: [
      h('h3', {}, 'People'),
      peopleList({ projectId: o.projectId, me: o.me, owner: o.owner, locked: o.locked, onChange: () => ((err.textContent = ''), o.onChange?.()), onError: fail }),
      h('h3', {}, 'Link'),
      h('label', { className: 'check' }, pub, h('span', {}, 'public: anyone with the link can view')),
      link, noteEl, err,
    ],
    foot: [h('button', { className: 'btn primary', type: 'button', onclick: () => m.close() }, 'done')],
  })
}
