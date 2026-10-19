import type { InviteInfo, Me } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { describeError } from '../errors'
import { dateOf } from '../format'
import { modal } from '../theme/dialog'
import { icon } from '../theme/icons'
import { nav } from '../ui/nav'
import './cloud.css'

/** A fresh invite link, ready to send, with a copy button. */
function inviteDialog(url: string, months: number) {
  const link = h('input', { readOnly: true, value: url, 'aria-label': 'invite link', onclick: () => link.select() })
  const copy = h('button', { className: 'btn primary', type: 'button', onclick: () =>
    navigator.clipboard.writeText(url).then(() => (copy.textContent = 'copied'), () => (link.select(), (copy.textContent = 'press ctrl+c'))),
  }, 'copy link')
  const m = modal({
    title: 'Invite link',
    className: 'share-dialog',
    body: [
      h('p', { className: 'modal-text' }, `Whoever opens this link can create one account${months ? `, with ${months} ${months === 1 ? 'month' : 'months'} of mobdaw pro` : ''}. Send it to one person.`),
      h('div', { className: 'share-link' }, link),
    ],
    foot: [h('button', { className: 'btn', type: 'button', onclick: () => m.close() }, 'close'), copy],
  })
  link.select()
}

/** What became of an invite. */
export function inviteState(i: Pick<InviteInfo, 'redeemedBy' | 'expiresAt'>, now = Date.now()): { text: string; open: boolean } {
  if (i.redeemedBy) return { text: `used by ${i.redeemedBy}`, open: false }
  if (i.expiresAt && i.expiresAt < now) return { text: 'expired', open: false }
  return { text: i.expiresAt ? `open until ${dateOf(i.expiresAt)}` : 'open', open: true }
}

/** Admin: create invites and see what became of them. */
export function adminPage(me: Me) {
  const months = h('input', { type: 'number', min: 0, max: 999, step: 1, value: '1', title: 'free months of pro the new account starts with' })
  const memo = h('input', { placeholder: 'who it is for (only you see this)', maxLength: 200 })
  const list = h('ul', { className: 'invites' })
  const empty = h('p', { className: 'dim' }, 'No invites yet.')
  const err = h('p', { className: 'error', role: 'alert' })
  const count = h('span', { className: 'dim' })

  const refresh = () =>
    api.invites().then((all) => {
      count.textContent = all.length ? `${all.filter((i) => inviteState(i).open).length} open of ${all.length}` : ''
      empty.hidden = !!all.length
      list.replaceChildren(...all.map((i) => {
        const st = inviteState(i)
        return h('li', {},
          h('span', { className: 'inv-memo' }, i.memo || h('span', { className: 'dim' }, 'no memo')),
          h('span', { className: `inv-state${st.open ? ' open' : ''}` }, st.text),
          h('span', { className: 'inv-sub' }, `${i.giftMonths} ${i.giftMonths === 1 ? 'month' : 'months'} · created ${dateOf(i.createdAt)} · ${i.token.slice(0, 8)}…`))
      }))
    }).catch((e) => (err.textContent = describeError(e)))

  const create = h('button', { className: 'btn primary', type: 'submit' }, icon('plus'), 'create invite')
  const form = h('form', { className: 'invite-form', onsubmit: (e: Event) => {
    e.preventDefault()
    err.textContent = ''
    create.disabled = true
    const n = Number(months.value)
    api.createInvite({ giftMonths: n, memo: memo.value.trim() })
      .then((r) => { memo.value = ''; inviteDialog(r.url, n); void refresh() }, (e) => (err.textContent = describeError(e)))
      .finally(() => (create.disabled = false))
  } },
  h('label', { className: 'field months' }, h('span', {}, 'free months'), months),
  h('label', { className: 'field memo' }, h('span', {}, 'memo'), memo),
  create)

  mount(nav(me), h('main', { className: 'page' },
    h('div', { className: 'page-head' }, h('h1', {}, 'Invites'), count),
    h('section', { className: 'panel' },
      h('h2', {}, 'New invite'),
      h('p', { className: 'dim' }, 'Accounts are by invite. Each link makes one account; the free months start when it is used.'),
      form, err),
    h('section', { className: 'panel' }, h('h2', {}, 'Sent'), empty, list)))
  void refresh()
}
