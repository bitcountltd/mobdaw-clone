// Snapshots (version history) of projects on this device: named copies of a project's document, kept in their own
// small IndexedDB database (`mobdaw-snapshots`) next to the projects. A snapshot is the document as one Yjs update; its
// audio stays in the project (content-addressed, local/audio.ts), and a restore copies what it refers to into the new
// project (pages/snapshots.ts). Automatic snapshots are taken when a project opens (see autoSnapshot).
import { getClips, samplesMap } from '@mobdaw/shared'
import * as Y from 'yjs'

export type Snapshot = {
  id: string
  project: string
  /** The project's name when it was taken. */
  projectName: string
  name: string
  at: number
  auto: boolean
  /** Size of the document state, in bytes. */
  size: number
  /** `Y.encodeStateAsUpdate` of the document. */
  state: Uint8Array
  /** `Y.encodeSnapshot` of the document (state vector + delete set): tells whether a document has changed since. */
  mark: Uint8Array
}
export type SnapshotInfo = Omit<Snapshot, 'state' | 'mark'>

export const AUTO_KEEP = 5
export const AUTO_EVERY = 30 * 60 * 1000

const DB_NAME = 'mobdaw-snapshots'
let dbp: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('project', 'project')
    req.onsuccess = () => {
      req.result.onversionchange = () => (req.result.close(), (dbp = undefined))
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
  }).catch((e) => {
    dbp = undefined
    throw e
  }))
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
const store = async (mode: IDBTransactionMode) => (await open()).transaction('snapshots', mode).objectStore('snapshots')
const info = ({ state: _s, mark: _m, ...rest }: Snapshot): SnapshotInfo => rest

/** The default name of a snapshot taken now: "Snapshot · 13 Oct 2026, 14:05". */
export function defaultSnapshotName(at = Date.now(), locale?: string): string {
  const d = new Date(at)
  return `Snapshot · ${d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`
}

/** The marker of a document's current content (see Snapshot.mark). */
export const docMark = (doc: Y.Doc) => Y.encodeSnapshot(Y.snapshot(doc))
/** True if the document has changed since `mark` was taken. */
export const changedSince = (doc: Y.Doc, mark: Uint8Array) => !Y.equalSnapshots(Y.snapshot(doc), Y.decodeSnapshot(mark))

/** A project's snapshots, newest first (without their contents). */
export async function listSnapshots(project: string): Promise<SnapshotInfo[]> {
  const all = (await done((await store('readonly')).index('project').getAll(project))) as Snapshot[]
  return all.map(info).sort((a, b) => b.at - a.at)
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return done((await store('readonly')).get(id)) as Promise<Snapshot | undefined>
}

export async function deleteSnapshot(id: string) {
  await done((await store('readwrite')).delete(id))
}

export async function deleteProjectSnapshots(project: string) {
  const s = await store('readwrite')
  const keys = await done(s.index('project').getAllKeys(project))
  await Promise.all(keys.map((k) => done(s.delete(k))))
}

/** Save the document as a snapshot. Automatic ones are kept to the newest AUTO_KEEP per project. */
export async function saveSnapshot(o: { project: string; projectName: string; doc: Y.Doc; name?: string; auto?: boolean; at?: number }): Promise<SnapshotInfo> {
  const at = o.at ?? Date.now()
  const state = Y.encodeStateAsUpdate(o.doc)
  const snap: Snapshot = {
    id: crypto.randomUUID(), project: o.project, projectName: o.projectName,
    name: o.name?.trim() || (o.auto ? 'Automatic snapshot' : defaultSnapshotName(at)),
    at, auto: !!o.auto, size: state.byteLength, state, mark: docMark(o.doc),
  }
  try {
    await done((await store('readwrite')).put(snap))
  } catch (e) {
    if ((e as DOMException)?.name === 'QuotaExceededError') throw new Error('your browser has no room left for another snapshot. delete some snapshots or free up disk space.')
    throw e
  }
  if (snap.auto) await pruneAuto(o.project)
  return info(snap)
}

/** Drop the oldest automatic snapshots beyond AUTO_KEEP. Named ones are never pruned. */
export async function pruneAuto(project: string, keep = AUTO_KEEP) {
  const autos = (await listSnapshots(project)).filter((s) => s.auto)
  for (const s of autos.slice(keep)) await deleteSnapshot(s.id)
}

/**
 * Whether an automatic snapshot is due: the last automatic one (or, before the first, the project's creation) is at
 * least AUTO_EVERY old, and the document differs from the newest snapshot of any kind.
 */
export function autoDue(o: { now: number; createdAt: number; lastAutoAt: number | null; changed: boolean }): boolean {
  return o.now - (o.lastAutoAt ?? o.createdAt) >= AUTO_EVERY && o.changed
}

/** Take an automatic snapshot of a project that has just been opened, if one is due. Returns it, or null. */
export async function autoSnapshot(o: { project: string; projectName: string; createdAt: number; doc: Y.Doc; now?: number }): Promise<SnapshotInfo | null> {
  const now = o.now ?? Date.now()
  const list = await listSnapshots(o.project)
  const lastAuto = list.find((s) => s.auto)
  const newest = list[0] && (await getSnapshot(list[0].id))
  const changed = !newest || changedSince(o.doc, newest.mark)
  if (!autoDue({ now, createdAt: o.createdAt, lastAutoAt: lastAuto?.at ?? null, changed })) return null
  return saveSnapshot({ project: o.project, projectName: o.projectName, doc: o.doc, auto: true, at: now })
}

/** The audio (content hashes) a document state refers to. */
export function referencedAudio(state: Uint8Array): string[] {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    const clips = getClips(doc).flatMap((c) => (c.kind === 'audio' ? [c.sourceHash] : []))
    return [...new Set([...samplesMap(doc).keys(), ...clips])]
  } finally {
    doc.destroy()
  }
}

/** Forget the open database (tests). */
export function _resetSnapshotDb() {
  void dbp?.then((db) => db.close()).catch(() => {})
  dbp = undefined
}
