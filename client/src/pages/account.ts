import { monthsLeft, type Me } from '@mobdaw/shared'
import { api } from '../api'
import { go } from '../router'
import { h, mount } from '../dom'
import { safeName, saveBlob } from '../download'
import { describeError } from '../errors'
import { bytes, dateOf, daysLeft } from '../format'
import { PROJECT_FILE_EXT, writeProjectFile } from '../projectFile'
import { collectCloud } from '../transfer'
import { confirmModal } from '../theme/dialog'
import { icon } from '../theme/icons'
import { nav } from '../ui/nav'
import './cloud.css'

/** Plan and storage, downloading everything, and the way to delete the account. */
export function accountPage(me: Me) {
  const err = h('p', { className: 'error', role: 'alert' })
  const delErr = h('p', { className: 'error', role: 'alert' })
  const password = h('input', { type: 'password', placeholder: 'your password', autocomplete: 'current-password', 'aria-label': 'your password' })

  const months = monthsLeft(me.paidThrough)
  const chip = me.planStatus === 'active' ? h('span', { className: 'plan-chip' }, 'active')
    : me.planStatus === 'lapsed' ? h('span', { className: 'plan-chip lapsed' }, 'ended') : h('span', { className: 'plan-chip ro' }, 'read-only')
  const plan = me.planStatus === 'read_only' && me.retentionEndsAt
    ? [h('p', {}, 'Your pre-paid time has run out. Your cloud projects and audio are read-only until ', h('strong', {}, dateOf(me.retentionEndsAt)),
        ` (${daysLeft(me.retentionEndsAt)} days), then they are permanently deleted. Your account stays, and you can use the cloud again whenever you add time.`)]
    : me.planStatus === 'lapsed'
    ? [h('p', {}, 'Your pre-paid time ran out and your cloud projects and audio have been deleted. Your account is still here: add time to use the cloud again, starting fresh.')]
    : [h('p', {}, 'Paid through ', h('strong', {}, dateOf(me.paidThrough)), ` (${months} ${months === 1 ? 'month' : 'months'} of pre-paid time).`),
        h('p', { className: 'dim' },
          'When pre-paid time runs out, your cloud projects and audio become read-only for 30 days so you can download them, and then they are deleted. ' +
          'Your account is never deleted automatically. Payments are not set up yet: time comes from invites and gifts.')]

  const share = me.quotaBytes ? Math.min(1, me.bytesUsed / me.quotaBytes) : 0
  const usage = h('div', { className: 'usage' },
    h('div', { className: 'usage-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(me.quotaBytes), 'aria-valuenow': String(me.bytesUsed), 'aria-label': 'storage used' },
      h('i', { style: `width:${(share * 100).toFixed(1)}%` })),
    h('span', { className: 'usage-text' }, `${bytes(me.bytesUsed)} of ${bytes(me.quotaBytes)} of audio storage used · `, h('a', { href: '#/uploads' }, 'manage uploads')))

  const progress = h('p', { className: 'dim status', role: 'status' })
  const buttons: HTMLButtonElement[] = []
  /** Run a download job with the buttons disabled and a running status line. */
  const job = (fn: () => Promise<void>) => async () => {
    err.textContent = ''
    buttons.forEach((b) => (b.disabled = true))
    try {
      await fn()
      progress.textContent = 'Done.'
    } catch (e) {
      progress.textContent = ''
      err.textContent = describeError(e)
    } finally {
      buttons.forEach((b) => (b.disabled = false))
    }
  }
  const downloadUploads = job(async () => {
    const uploads = await api.uploads()
    if (!uploads.length) return void (progress.textContent = 'You have no uploads.')
    for (const [i, u] of uploads.entries()) {
      progress.textContent = `downloading ${i + 1} of ${uploads.length}: ${u.name || u.hash.slice(0, 12)}…`
      const res = await fetch((await api.uploadFileUrl(u.hash)).url)
      if (!res.ok) throw new Error(`http ${res.status}`)
      saveBlob(await res.blob(), safeName(u.name, u.hash.slice(0, 12)))
    }
  })
  const downloadProjects = job(async () => {
    const mine = (await api.projects()).filter((p) => p.role === 'owner')
    if (!mine.length) return void (progress.textContent = 'You own no cloud projects.')
    for (const p of mine) saveBlob(writeProjectFile(await collectCloud(p.id, me, (m) => (progress.textContent = m))), safeName(p.name) + PROJECT_FILE_EXT)
  })
  buttons.push(
    h('button', { className: 'btn', type: 'button', onclick: downloadUploads }, icon('export'), 'download my uploads'),
    h('button', { className: 'btn', type: 'button', onclick: downloadProjects }, icon('export'), `download my projects (${PROJECT_FILE_EXT})`),
  )

  const del = h('button', { className: 'btn danger', type: 'button', onclick: async () => {
    delErr.textContent = ''
    if (!password.value) return void (delErr.textContent = 'Enter your password to confirm.')
    const yes = await confirmModal({
      title: 'Delete your account?',
      text: 'Your projects (for everyone you shared them with) and all of your uploads are permanently deleted, now. This cannot be undone.',
      action: 'delete my account', danger: true,
    })
    if (yes) api.deleteAccount(password.value).then(() => go('/'), (e) => (delErr.textContent = describeError(e)))
  } }, 'delete my account')

  mount(nav(me), h('main', { className: 'page' },
    h('div', { className: 'page-head' }, h('h1', {}, 'Account'), h('span', { className: 'dim' }, me.username)),
    h('section', { className: 'panel' },
      h('div', { className: 'plan-line' }, h('h2', {}, 'mobdaw pro'), chip),
      ...plan, usage),
    h('section', { className: 'panel' },
      h('h2', {}, 'Download your data'),
      h('p', { className: 'dim' }, `Uploads come back as the original audio files. Projects come back as ${PROJECT_FILE_EXT} files, each with its audio: import one from the home page to open it on this device.`),
      h('div', { className: 'row' }, ...buttons),
      progress, err),
    h('section', { className: 'panel danger-zone' },
      h('h2', {}, 'Delete account'),
      h('p', { className: 'dim' }, 'Deletes your account, your cloud projects and your audio immediately. This is the only way an account is ever deleted. Download anything you want to keep first.'),
      h('form', { className: 'row', onsubmit: (e: Event) => (e.preventDefault(), del.click()) }, password, del),
      delErr)))
}
