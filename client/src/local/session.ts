import { projectPreview, undoScope, userColor, type AwarenessState } from '@mobdaw/shared'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import type { Session } from '../project/session'
import { docDb } from './ids'
import { getLocal, touchLocal } from './projects'
import { autoSnapshot } from '../snapshots'

// When IndexedDB can't be opened (site storage blocked, or a broken profile), y-indexeddb's whenSynced never settles.
// `loaded` settles either way: true when the saved document is loaded, false when there is no storage. Without storage,
// a project's state lives only in memory for this page (`unsaved`), so a new project still opens.
const unsaved = new Map<string, Uint8Array>()
function loaded(p: IndexeddbPersistence): Promise<boolean> {
  const db = (p as unknown as { _db: Promise<unknown> })._db
  return Promise.race([p.whenSynced.then(() => true), db.then(() => new Promise<boolean>(() => {}), (e) => (console.warn('local storage:', e), false))])
}
const destroyQuietly = (p: IndexeddbPersistence) => p.destroy().catch(() => {})

/** A local session; `storageFailed` resolves true if the document can't be saved in this browser (it's in memory only). */
export type LocalSession = Session & { storageFailed: Promise<boolean> }

/** Open a project that lives on this device: same shape as a cloud session, but the document is saved to IndexedDB. */
export function openLocalSession(projectId: string): LocalSession {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(docDb(projectId), doc)
  const ok = loaded(persistence)
  const storageFailed = ok.then((v) => {
    const st = unsaved.get(projectId)
    if (!v && st && !doc.isDestroyed) Y.applyUpdate(doc, st)
    return !v
  })
  const awareness = new Awareness(doc)
  const user: AwarenessState['user'] = { username: 'you', color: userColor('you') }
  awareness.setLocalStateField('user', user)
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  let touched = 0
  const onUpdate = () => {
    clearTimeout(touched)
    touched = window.setTimeout(() => touchLocal(projectId), 2000) // "last edited", for sorting the list
  }
  doc.on('update', onUpdate)
  // version history: keep a rolling automatic snapshot of the project as it was when opened (snapshots.ts)
  void ok.then((v) => {
    const p = getLocal(projectId)
    if (!v) return
    if (p && !doc.isDestroyed) return autoSnapshot({ project: projectId, projectName: p.name, createdAt: p.createdAt, doc })
  }).catch((e) => console.warn('automatic snapshot:', e))
  return {
    projectId, doc, provider: null, local: true, awareness, undo, user, userId: null,
    synced: storageFailed.then(() => {}),
    storageFailed,
    setLocal: (patch) => {
      for (const [k, v] of Object.entries(patch)) awareness.setLocalStateField(k, v)
    },
    remoteStates: () => [],
    destroy() {
      clearTimeout(touched)
      touchLocal(projectId)
      doc.off('update', onUpdate)
      undo.destroy()
      awareness.destroy()
      if (unsaved.has(projectId)) unsaved.set(projectId, Y.encodeStateAsUpdate(doc))
      void destroyQuietly(persistence)
      doc.destroy()
    },
  }
}

/** A local project's document state, without opening an editor. */
export async function readLocalState(projectId: string): Promise<Uint8Array> {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(docDb(projectId), doc)
  if (!(await loaded(persistence))) {
    void destroyQuietly(persistence)
    doc.destroy()
    return unsaved.get(projectId) ?? Y.encodeStateAsUpdate(new Y.Doc())
  }
  const state = Y.encodeStateAsUpdate(doc)
  await persistence.destroy()
  doc.destroy()
  return state
}

/** Write a document state as a local project's saved document. */
export async function writeLocalState(projectId: string, state: Uint8Array) {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(docDb(projectId), doc)
  if (!(await loaded(persistence))) {
    unsaved.set(projectId, state) // (kept in memory for this page)
    void destroyQuietly(persistence)
    doc.destroy()
    return
  }
  Y.applyUpdate(doc, state)
  await persistence.destroy() // flushes pending writes
  doc.destroy()
}

/** The little picture of a local project for the project list. */
export async function readLocalPreview(projectId: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await readLocalState(projectId))
  const preview = projectPreview(doc)
  doc.destroy()
  return preview
}
