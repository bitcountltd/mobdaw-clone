// Where a project's changes are: saved, on their way, or waiting for the connection to come back. One source for the
// top bar's saved dot, the status bar and the page's "leave the page?" guard.
import type { Session } from './session'

export type SyncState = 'saved' | 'saving' | 'connecting' | 'offline'

/** What the connection is doing, as far as the saved state cares. */
export type SyncInput = { connected: boolean; everConnected: boolean; unsynced: number }

/**
 * A cloud project's state. Before the first connection it is connecting; after a drop it is offline (with or without
 * edits waiting: they are kept in this tab and sent on reconnect); connected, it is saving until the server has
 * acknowledged every change.
 */
export function cloudSync(i: SyncInput): SyncState {
  if (!i.connected) return i.everConnected ? 'offline' : 'connecting'
  return i.unsynced > 0 ? 'saving' : 'saved'
}

/** The short word in the top bar. */
export const syncWord = (state: SyncState) =>
  ({ saved: 'saved', saving: 'saving…', connecting: 'connecting…', offline: 'offline' })[state]

/** The longer line: the status bar's place for it, and the hover hint. */
export function syncLine(state: SyncState, local: boolean, pending = 0): string {
  if (local) return state === 'saving' ? 'saving on this device…' : 'saved on this device'
  if (state === 'saved') return 'saved to the cloud'
  if (state === 'saving') return 'saving to the cloud…'
  if (state === 'connecting') return 'connecting to the cloud…'
  return pending > 0 ? `offline: ${pending === 1 ? 'a change' : 'changes'} waiting to sync` : 'offline: reconnecting…'
}

export function syncHint(state: SyncState, local: boolean): string {
  if (local) return 'every change is saved in this browser, on this device; export a .mobdaw file from the home page to move it'
  if (state === 'offline') return 'the connection to the server dropped: keep this tab open and your changes are sent when it reconnects'
  if (state === 'connecting') return 'opening the project on the server'
  return 'every change is saved to the cloud and shared with everyone in the project'
}

/**
 * Follow a session's saved state. Projects on this device are "saving" briefly after each edit; cloud projects follow
 * the connection and the server's acknowledgements. Returns the unsubscribe function.
 */
export function watchSync(s: Session, on: (state: SyncState, pending: number) => void): () => void {
  const p = s.provider
  if (!p) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onUpdate = () => {
      on('saving', 0)
      clearTimeout(timer)
      timer = setTimeout(() => on('saved', 0), 600)
    }
    s.doc.on('update', onUpdate)
    on('saved', 0)
    return () => (clearTimeout(timer), s.doc.off('update', onUpdate))
  }
  let connected = p.configuration.websocketProvider?.status === 'connected' && p.isSynced
  let everConnected = connected
  let last = ''
  const emit = () => {
    const state = cloudSync({ connected, everConnected, unsynced: p.unsyncedChanges })
    const key = `${state}:${p.unsyncedChanges}`
    if (key !== last) (last = key), on(state, p.unsyncedChanges)
  }
  const onStatus = ({ status }: { status: string }) => {
    // (connected again, but saved only once the handshake is done: the 'synced' event)
    if (status !== 'connected') connected = false
    emit()
  }
  const onSynced = ({ state }: { state: boolean }) => {
    if (state) connected = everConnected = true
    emit()
  }
  p.on('status', onStatus)
  p.on('synced', onSynced)
  p.on('unsyncedChanges', emit)
  emit()
  return () => {
    p.off('status', onStatus)
    p.off('synced', onSynced)
    p.off('unsyncedChanges', emit)
  }
}
