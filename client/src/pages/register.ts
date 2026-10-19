import { api } from '../api'
import { h, mount } from '../dom'
import { homeLink } from '../router'
import { authMessage } from './login'

/** Registration form; `invite` (from the `#/register/<code>` link) prefills the invite code. */
export function registerPage(invite: string, done: () => void) {
  const err = h('p', { className: 'error' })
  // (from an invite link the code is already filled in: no need to show it)
  const code = h('input', { placeholder: 'invite code', required: true, value: invite, autocomplete: 'off', hidden: !!invite, 'aria-label': 'invite code' })
  const username = h('input', { placeholder: 'username', required: true, autofocus: !!invite, autocomplete: 'username' })
  const password = h('input', { type: 'password', placeholder: 'password (8+ characters)', required: true, autocomplete: 'new-password' })
  const again = h('input', { type: 'password', placeholder: 'password again', required: true, autocomplete: 'new-password' })
  mount(h('main', { className: 'center' },
    h('div', { className: 'card' },
      h('h1', { className: 'logo' }, 'mobdaw'),
      h('p', { className: 'dim' }, invite ? "you're invited. pick a username and a password." : 'invite only for now. paste the code from your invite, or open the invite link.'),
      h('form', {
        onsubmit: (e: Event) => {
          e.preventDefault()
          err.textContent = ''
          if (password.value !== again.value) return void (err.textContent = 'passwords do not match.')
          api.register({ username: username.value, password: password.value, invite: code.value }).then(done, (x) => (err.textContent = authMessage(x)))
        },
      }, code, username, password, again, h('button', { className: 'btn primary' }, 'register')),
      err,
      h('p', { className: 'dim' }, 'already have an account? ', h('a', { href: '#/login' }, 'log in')),
      h('p', { className: 'dim' }, h('a', homeLink, 'continue without an account'), ' to work locally.'))))
}
