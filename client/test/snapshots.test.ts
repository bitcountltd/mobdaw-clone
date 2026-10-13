import 'fake-indexeddb/auto'
import { addTrack, samplesMap } from '@mobdaw/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  AUTO_EVERY, AUTO_KEEP, _resetSnapshotDb, autoDue, autoSnapshot, changedSince, defaultSnapshotName, deleteProjectSnapshots,
  deleteSnapshot, docMark, getSnapshot, listSnapshots, referencedAudio, saveSnapshot,
} from '../src/snapshots'

const MIN = 60_000
const docWith = (...names: string[]) => {
  const d = new Y.Doc()
  for (const n of names) addTrack(d, n)
  return d
}

beforeEach(async () => {
  _resetSnapshotDb()
  await new Promise<void>((r) => {
    const q = indexedDB.deleteDatabase('mobdaw-snapshots')
    q.onsuccess = q.onerror = q.onblocked = () => r()
  })
})

describe('snapshot store', () => {
  it('saves, lists newest first, reads back the state, and deletes', async () => {
    const doc = docWith('drums')
    const a = await saveSnapshot({ project: 'p1', projectName: 'Song', doc, name: 'first', at: 1000 })
    addTrack(doc, 'bass')
    const b = await saveSnapshot({ project: 'p1', projectName: 'Song', doc, name: '  ', at: 2000 })
    await saveSnapshot({ project: 'p2', projectName: 'Other', doc, name: 'elsewhere', at: 3000 })

    const list = await listSnapshots('p1')
    expect(list.map((s) => s.id)).toEqual([b.id, a.id])
    expect(list[1]).toMatchObject({ name: 'first', project: 'p1', projectName: 'Song', auto: false, at: 1000 })
    expect(list[0].name).toBe(defaultSnapshotName(2000)) // blank name: the default
    expect(list[0]).not.toHaveProperty('state') // (the list is light)

    const full = await getSnapshot(a.id)
    expect(full!.size).toBe(full!.state.byteLength)
    const back = new Y.Doc()
    Y.applyUpdate(back, full!.state)
    expect([...back.getMap('tracks').values()].map((t) => (t as Y.Map<unknown>).get('name'))).toEqual(['drums'])

    await deleteSnapshot(a.id)
    expect((await listSnapshots('p1')).map((s) => s.id)).toEqual([b.id])
    await deleteProjectSnapshots('p1')
    expect(await listSnapshots('p1')).toEqual([])
    expect(await listSnapshots('p2')).toHaveLength(1)
  })

  it('keeps only the newest automatic snapshots, never pruning named ones', async () => {
    const doc = docWith('a')
    const named = await saveSnapshot({ project: 'p', projectName: 'S', doc, name: 'keep me', at: 1 })
    for (let i = 0; i < AUTO_KEEP + 3; i++) await saveSnapshot({ project: 'p', projectName: 'S', doc, auto: true, at: 100 + i })
    const list = await listSnapshots('p')
    const autos = list.filter((s) => s.auto)
    expect(autos).toHaveLength(AUTO_KEEP)
    expect(autos.map((s) => s.at)).toEqual([107, 106, 105, 104, 103])
    expect(list.some((s) => s.id === named.id)).toBe(true)
  })
})

describe('change detection', () => {
  it('sees additions and deletions, and not a reload of the same content', () => {
    const doc = docWith('a', 'b')
    const mark = docMark(doc)
    expect(changedSince(doc, mark)).toBe(false)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    expect(changedSince(copy, mark)).toBe(false) // same content, loaded again
    const id = [...doc.getMap('tracks').keys()][0]
    doc.getMap('tracks').delete(id) // a delete adds no new items, only to the delete set
    expect(changedSince(doc, mark)).toBe(true)
  })
})

describe('automatic snapshots', () => {
  it('is due after 30 minutes, and only if something changed', () => {
    expect(autoDue({ now: AUTO_EVERY, createdAt: 0, lastAutoAt: null, changed: true })).toBe(true)
    expect(autoDue({ now: AUTO_EVERY - 1, createdAt: 0, lastAutoAt: null, changed: true })).toBe(false)
    expect(autoDue({ now: 100 * MIN, createdAt: 0, lastAutoAt: 80 * MIN, changed: true })).toBe(false)
    expect(autoDue({ now: 100 * MIN, createdAt: 0, lastAutoAt: 60 * MIN, changed: false })).toBe(false)
    expect(autoDue({ now: 100 * MIN, createdAt: 0, lastAutoAt: 60 * MIN, changed: true })).toBe(true)
  })

  it('takes one on open when due, skips an unchanged doc, and rolls', async () => {
    const doc = docWith('a')
    const o = { project: 'p', projectName: 'S', createdAt: 0, doc }
    expect(await autoSnapshot({ ...o, now: 10 * MIN })).toBeNull() // a project just made
    const first = await autoSnapshot({ ...o, now: 40 * MIN })
    expect(first).toMatchObject({ auto: true, at: 40 * MIN })
    expect(await autoSnapshot({ ...o, now: 90 * MIN })).toBeNull() // nothing changed since
    addTrack(doc, 'b')
    expect(await autoSnapshot({ ...o, now: 60 * MIN })).toBeNull() // changed, but too soon
    let t = 90 * MIN
    for (let i = 0; i < AUTO_KEEP + 2; i++, t += 31 * MIN) {
      addTrack(doc, 't' + i)
      expect(await autoSnapshot({ ...o, now: t })).not.toBeNull()
    }
    const autos = (await listSnapshots('p')).filter((s) => s.auto)
    expect(autos).toHaveLength(AUTO_KEEP)
    expect(autos.some((s) => s.id === first!.id)).toBe(false) // the oldest went first
  })

  it('compares against the newest snapshot of any kind', async () => {
    const doc = docWith('a')
    await saveSnapshot({ project: 'p', projectName: 'S', doc, name: 'by hand', at: 50 * MIN })
    expect(await autoSnapshot({ project: 'p', projectName: 'S', createdAt: 0, doc, now: 60 * MIN })).toBeNull()
  })
})

describe('referenced audio', () => {
  it('lists the library and the audio clips’ sources', () => {
    const doc = new Y.Doc()
    samplesMap(doc).set('a'.repeat(64), { hash: 'a'.repeat(64), name: 'kick', duration: 1, size: 1, mime: 'audio/wav' })
    const clip = new Y.Map<unknown>()
    doc.getMap('clips').set('c1', clip)
    for (const [k, v] of Object.entries({ id: 'c1', kind: 'audio', trackId: 't', start: 0, length: 1, sourceHash: 'b'.repeat(64), sourceOffset: 0 })) clip.set(k, v)
    expect(referencedAudio(Y.encodeStateAsUpdate(doc)).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)])
  })
})
