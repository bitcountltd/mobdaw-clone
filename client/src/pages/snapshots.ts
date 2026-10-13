// Snapshots of a project on this device, in dialogs: "save a snapshot" (named) and "snapshots…" (the list, with
// restore as a new project, download as .mobdaw, delete). Used by the studio's project menu and the home page tiles.
// The store and the automatic snapshots are in ../snapshots.ts.
import * as Y from 'yjs'
import { h } from '../dom'
import { safeName, saveBlob } from '../download'
import { describeError } from '../errors'
import { bytes } from '../format'
import { listAudio } from '../local/audio'
import { getLocal, type LocalProject } from '../local/projects'
import { readLocalState } from '../local/session'
import { PROJECT_FILE_EXT, writeProjectFile, type ProjectContents } from '../projectFile'
import {
  defaultSnapshotName, deleteSnapshot, getSnapshot, listSnapshots, referencedAudio, saveSnapshot,
  type Snapshot, type SnapshotInfo,
} from '../snapshots'
import { confirmModal, modal } from '../theme/dialog'
import { icon } from '../theme/icons'
import { importToLocal } from '../transfer'
import { edited } from './edited'
import './snapshots.css'

/** Where the document to snapshot comes from: the open studio's live doc, or the project's saved state. */
export type DocSource = () => Promise<{ doc: Y.Doc; release(): void }>

/** The saved document of a project on this device (when it is not open in the studio). */
export const savedDoc = (project: string): DocSource => async () => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await readLocalState(project))
  return { doc, release: () => doc.destroy() }
}
/** An open document (the studio's). */
export const liveDoc = (doc: Y.Doc): DocSource => async () => ({ doc, release: () => {} })

const nameOf = (project: string, fallback: string) => getLocal(project)?.name ?? fallback

/** A snapshot as a whole project: its document and the project's audio that it refers to (what is still there). */
export async function snapshotContents(s: Snapshot, name: string): Promise<ProjectContents & { missing: number }> {
  const want = new Set(referencedAudio(s.state))
  const rows = (await listAudio(s.project).catch(() => [])).filter((a) => want.has(a.hash))
  return {
    name, state: s.state,
    audio: rows.map((a) => ({ hash: a.hash, mime: a.mime, name: a.name, blob: a.blob })),
    missing: want.size - rows.length,
  }
}

/** Restore a snapshot as a NEW project on this device ("<name> (restored)"), with its audio. Never overwrites. */
export async function restoreSnapshot(id: string): Promise<LocalProject> {
  const s = await getSnapshot(id)
  if (!s) throw new Error('that snapshot is gone.')
  const { missing: _, ...c } = await snapshotContents(s, `${nameOf(s.project, s.projectName)} (restored)`)
  return importToLocal(c)
}

/** Ask for a name and save a snapshot. Resolves with it, or null when cancelled. */
export function saveSnapshotDialog(o: { project: string; projectName: string; source: DocSource }): Promise<SnapshotInfo | null> {
  return new Promise((resolve) => {
    let result: SnapshotInfo | null = null
    const input = h('input', { value: defaultSnapshotName(), spellcheck: false, maxLength: 120, 'aria-label': 'snapshot name' })
    const err = h('p', { className: 'error', role: 'alert' })
    const save = h('button', { className: 'btn primary', type: 'submit' }, 'save snapshot')
    const form = h('form', { className: 'snap-form' },
      h('label', { className: 'field' }, h('span', {}, 'Name'), input),
      h('p', { className: 'modal-text' }, 'A copy of the project as it is now, kept in this browser. Restoring makes a new project, so this one is never overwritten.'),
      err)
    form.onsubmit = async (e) => {
      e.preventDefault()
      save.disabled = true
      err.textContent = ''
      try {
        const src = await o.source()
        try {
          result = await saveSnapshot({ project: o.project, projectName: nameOf(o.project, o.projectName), doc: src.doc, name: input.value })
        } finally {
          src.release()
        }
        m.close()
      } catch (x) {
        err.textContent = describeError(x)
        save.disabled = false
      }
    }
    save.setAttribute('form', (form.id = 'snap-form-' + Math.random().toString(36).slice(2)))
    const m = modal({
      title: 'Save a snapshot', className: 'snap-dialog snap-save',
      body: [form],
      foot: [h('button', { className: 'btn', type: 'button', onclick: () => m.close() }, 'cancel'), save],
      onClose: () => resolve(result),
    })
    input.select()
  })
}

/** "13 oct, 14:05": when a snapshot was taken, exactly (the relative time sits next to it). */
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: '2-digit', minute: '2-digit' }).toLowerCase()

/**
 * The project's snapshots. `source` (the document to snapshot) adds a "save a snapshot" button. `onRestored` runs with
 * the new project after a restore (default: open it).
 */
export function snapshotsDialog(o: { project: string; projectName: string; source?: DocSource; onRestored?(p: LocalProject): void }) {
  const list = h('ul', { className: 'snap-list' })
  const status = h('p', { className: 'dim snap-status', role: 'status' })
  const err = h('p', { className: 'error', role: 'alert' })
  const opened = (p: LocalProject) => (o.onRestored ? o.onRestored(p) : (location.hash = `#/local/${p.id}`))

  const busy = async (msg: string, fn: () => Promise<unknown>) => {
    err.textContent = ''
    status.textContent = msg
    list.inert = true
    try {
      await fn()
      status.textContent = ''
    } catch (x) {
      status.textContent = ''
      err.textContent = describeError(x)
    } finally {
      list.inert = false
    }
  }

  const row = (s: SnapshotInfo) => {
    const restore = h('button', { className: 'btn sm', title: `restore as a new project, “${nameOf(o.project, o.projectName)} (restored)”, and open it`, onclick: () => busy('restoring…', async () => {
      const p = await restoreSnapshot(s.id)
      m.close()
      opened(p)
    }) }, 'restore')
    const download = h('button', { className: 'icon-btn', title: `download as ${PROJECT_FILE_EXT} (with its audio)`, 'aria-label': `download ${s.name}`, onclick: () => busy('preparing the file…', async () => {
      const snap = await getSnapshot(s.id)
      if (!snap) throw new Error('that snapshot is gone.')
      const c = await snapshotContents(snap, `${nameOf(o.project, o.projectName)} · ${s.name}`)
      // (a filename with "·" in it is refused by Chromium: it saves as "download")
      saveBlob(writeProjectFile(c), safeName(c.name.replace(/\s*·\s*/g, ' - ')) + PROJECT_FILE_EXT)
      if (c.missing) status.textContent = `${c.missing} audio file${c.missing === 1 ? ' is' : 's are'} no longer on this device and could not be included.`
    }) }, icon('export'))
    const del = h('button', { className: 'icon-btn', title: 'delete this snapshot', 'aria-label': `delete ${s.name}`, onclick: async () => {
      // (the confirmation is a second dialog over this one)
      const yes = await confirmModal({ title: `Delete “${s.name}”?`, text: 'The snapshot is removed from this device. The project itself is not changed.', action: 'delete', danger: true })
      if (yes) await busy('deleting…', async () => (await deleteSnapshot(s.id), await render()))
    } }, icon('trash'))
    return h('li', { className: 'snap-row' },
      h('div', { className: 'snap-main' },
        h('span', { className: 'snap-name' }, s.name, s.auto ? h('span', { className: 'snap-tag', title: 'taken automatically when the project was opened' }, 'auto') : null),
        h('span', { className: 'snap-sub dim' },
          h('time', { dateTime: new Date(s.at).toISOString(), title: new Date(s.at).toLocaleString() }, when(s.at)),
          h('span', { className: 'faint' }, ' · '), edited(s.at).replace(/^edited /, ''),
          h('span', { className: 'faint' }, ' · '), h('span', { className: 'num' }, bytes(s.size)))),
      restore, download, del)
  }

  const empty = h('div', { className: 'snap-empty' },
    h('p', {}, 'No snapshots yet.'),
    h('p', { className: 'dim' }, 'Save one before a big change. mobdaw also keeps the last five automatic ones, taken when you open a project you changed more than half an hour before.'))

  async function render() {
    const all = await listSnapshots(o.project)
    list.replaceChildren(...all.map(row))
    list.hidden = !all.length
    empty.hidden = !!all.length
  }

  const add = o.source && h('button', { className: 'btn', onclick: async () => {
    const s = await saveSnapshotDialog({ project: o.project, projectName: o.projectName, source: o.source! })
    if (s) await render()
  } }, icon('plus'), 'save a snapshot')
  const m = modal({
    title: `Snapshots · ${nameOf(o.project, o.projectName)}`, className: 'snap-dialog',
    body: [list, empty, status, err],
    foot: [add ?? null, h('span', { className: 'grow' }), h('button', { className: 'btn', onclick: () => m.close() }, 'close')],
  })
  list.hidden = empty.hidden = true
  void render().catch((x) => (err.textContent = describeError(x)))
  return m
}
