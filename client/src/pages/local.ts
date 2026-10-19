import type { Me } from '@mobdaw/shared'
import * as Y from 'yjs'
import { CLOUD } from '../cloud'
import { h } from '../dom'
import { filePicker } from '../fileTypes'
import { safeName, saveBlob } from '../download'
import { describeError } from '../errors'
import { listLocal, removeLocal, renameLocal, type LocalProject } from '../local/projects'
import { readLocalState } from '../local/session'
import { PROJECT_FILE_EXT, writeProjectFile } from '../projectFile'
import { confirmModal } from '../theme/dialog'
import { icon } from '../theme/icons'
import { collectLocal, importProjectFile, importToLocal, localToCloud } from '../transfer'
import { edited } from './edited'
import { saveSnapshotDialog, savedDoc, snapshotsDialog } from './snapshots'
import { docPicture, projectTile, renameInPlace, type TileAction } from '../ui/tile'

/** A local project's picture, in its tracks' colours. */
async function localPicture(id: string) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, await readLocalState(id))
    return docPicture(doc)
  } finally {
    doc.destroy()
  }
}

/** The file picker behind "import": opens a .mobdaw file as a new local project and lands in it. */
export function importButton(label = 'import a project file', cls = 'btn'): HTMLElement {
  const picker = filePicker(`${PROJECT_FILE_EXT},application/x-mobdaw-project`)
  const text = h('span', {}, label)
  const btn = h('button', { className: cls, title: `open a ${PROJECT_FILE_EXT} file as a new project on this device`, onclick: () => picker.click() }, icon('upload'), text)
  picker.onchange = async () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (!file) return
    text.textContent = 'importing…'
    btn.disabled = true
    try {
      location.hash = `#/local/${(await importProjectFile(file)).id}`
    } catch (e) {
      alert(describeError(e))
    } finally {
      text.textContent = label
      btn.disabled = false
    }
  }
  return h('span', { className: 'import' }, btn, picker)
}

/**
 * Projects on this device. Works with no account: nothing here is sent to the server. With the cloud build, a
 * signed-in account can also move a project into the cloud (where it can be shared and edited together).
 */
export function localSection(me: Me | null): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error', role: 'alert' })
  const status = h('p', { className: 'dim status', role: 'status' })
  const count = h('span', { className: 'sec-count num' })

  const busy = async (msg: string, fn: () => Promise<unknown>) => {
    err.textContent = ''
    status.textContent = msg
    try {
      await fn()
    } catch (e) {
      err.textContent = describeError(e)
    } finally {
      status.textContent = ''
    }
    render()
  }

  const canUpload = CLOUD && !!me && me.planStatus === 'active'

  function tile(p: LocalProject) {
    const actions: TileAction[] = [
      { label: 'rename', icon: 'edit', onclick: () => renameInPlace(el, p.name, (n) => (renameLocal(p.id, n), render())) },
      { label: 'duplicate', icon: 'duplicate', title: 'make a copy of this project and its audio', onclick: () => busy(`duplicating ${p.name}…`, async () => {
        await importToLocal({ ...(await collectLocal(p.id)), name: `${p.name} copy` })
      }) },
      { label: 'save a snapshot', icon: 'plus', title: 'keep a copy of this project as it is now (version history)', onclick: () => {
        void saveSnapshotDialog({ project: p.id, projectName: p.name, source: savedDoc(p.id) }).then((s) => {
          if (!s) return
          const msg = (status.textContent = `saved “${s.name}”`)
          setTimeout(() => status.textContent === msg && (status.textContent = ''), 4000)
        })
      } },
      { label: 'snapshots…', icon: 'folder', title: 'earlier versions of this project: restore, download or delete', onclick: () => {
        snapshotsDialog({ project: p.id, projectName: p.name, source: savedDoc(p.id) }).el.addEventListener('close', () => render())
      } },
      { label: `export ${PROJECT_FILE_EXT}`, icon: 'export', title: 'save this project and its audio as one file', onclick: () => busy(`exporting ${p.name}…`, async () => {
        saveBlob(writeProjectFile(await collectLocal(p.id)), safeName(p.name) + PROJECT_FILE_EXT)
      }) },
      ...(CLOUD && me ? [{
        label: 'upload to cloud', icon: 'upload' as const, disabled: !canUpload,
        title: canUpload ? 'put a copy in the cloud, with its audio, where you can share it (this copy stays on this device)' : 'your subscription has ended',
        onclick: () => busy(`uploading ${p.name}…`, async () => {
          const id = await localToCloud(p.id, me, (m) => (status.textContent = m))
          location.hash = `#/project/${id}`
        }),
      }] : []),
      { label: 'delete', icon: 'trash', danger: true, onclick: async () => {
        const yes = await confirmModal({
          title: `Delete “${p.name}”?`,
          text: 'The project, its audio and its snapshots are removed from this device. This cannot be undone: export it first to keep a copy.',
          action: 'delete', danger: true,
        })
        if (yes) busy('deleting…', () => removeLocal(p.id))
      } },
    ]
    const el: HTMLElement = projectTile({ href: `#/local/${p.id}`, name: p.name, details: [edited(p.updatedAt)], preview: () => localPicture(p.id), actions })
    return el
  }

  function render() {
    const all = listLocal()
    count.textContent = all.length ? String(all.length) : ''
    list.replaceChildren(...all.map(tile))
    list.hidden = !all.length
    empty.hidden = !!all.length
  }

  const empty = h('div', { className: 'tiles-empty' },
    h('p', {}, 'Nothing here yet. Start from a template above, or bring in a project you exported.'),
    h('p', { className: 'dim' }, 'Projects live in this browser, on this device. Export a project to move it or keep a backup.'))

  const section = h('section', { className: 'home-sec', 'aria-labelledby': 'local-h' },
    h('div', { className: 'sec-head' }, h('h2', { id: 'local-h' }, CLOUD && me ? 'On this device' : 'Your projects'), count, h('span', { className: 'grow' }), importButton()),
    status, err, list, empty)
  render()
  return section
}
