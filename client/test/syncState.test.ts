import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { cloudSync, syncLine, watchSync, type SyncState } from '../src/project/syncState'
import type { Session } from '../src/project/session'

/** Just enough of a HocuspocusProvider: events, status, the synced flag and the unsynced count. */
function fakeProvider() {
  const handlers = new Map<string, Set<(e: any) => void>>()
  const p = {
    configuration: { websocketProvider: { status: 'connecting' } },
    isSynced: false,
    unsyncedChanges: 0,
    on: (ev: string, f: (e: any) => void) => void (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(f),
    off: (ev: string, f: (e: any) => void) => void handlers.get(ev)?.delete(f),
    emit: (ev: string, e?: unknown) => handlers.get(ev)?.forEach((f) => f(e)),
  }
  return p
}

describe('sync state', () => {
  it('cloud: connecting, saved, saving, offline with edits kept', () => {
    expect(cloudSync({ connected: false, everConnected: false, unsynced: 0 })).toBe('connecting')
    expect(cloudSync({ connected: true, everConnected: true, unsynced: 0 })).toBe('saved')
    expect(cloudSync({ connected: true, everConnected: true, unsynced: 2 })).toBe('saving')
    expect(cloudSync({ connected: false, everConnected: true, unsynced: 0 })).toBe('offline')
    // an edit made while offline does not make it look like it is saving
    expect(cloudSync({ connected: false, everConnected: true, unsynced: 3 })).toBe('offline')
  })
  it('says where the project is saved', () => {
    expect(syncLine('saved', true)).toBe('saved on this device')
    expect(syncLine('saved', false)).toBe('saved to the cloud')
    expect(syncLine('offline', false, 2)).toMatch(/waiting to sync/)
  })
  it('follows the provider through a drop and a reconnect', () => {
    const p = fakeProvider()
    const seen: SyncState[] = []
    const off = watchSync({ provider: p, doc: new Y.Doc(), local: false } as unknown as Session, (s) => seen.push(s))
    p.configuration.websocketProvider.status = 'connected'
    p.emit('status', { status: 'connected' })
    p.isSynced = true
    p.emit('synced', { state: true })
    p.unsyncedChanges = 1
    p.emit('unsyncedChanges', { number: 1 })
    p.unsyncedChanges = 0
    p.emit('unsyncedChanges', { number: 0 })
    p.emit('status', { status: 'disconnected' })
    p.unsyncedChanges = 1 // edited while offline
    p.emit('unsyncedChanges', { number: 1 })
    p.emit('status', { status: 'connecting' })
    p.emit('status', { status: 'connected' })
    p.emit('synced', { state: true })
    p.unsyncedChanges = 0
    p.emit('unsyncedChanges', { number: 0 })
    off()
    p.emit('status', { status: 'disconnected' })
    expect(seen.filter((s, i) => s !== seen[i - 1])).toEqual(['connecting', 'saved', 'saving', 'saved', 'offline', 'saving', 'saved'])
  })
})
