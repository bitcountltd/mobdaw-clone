// Track heights: a local view setting per track (not in the doc), remembered on this device per project.
// The headers resize them (drag the bottom edge); the lanes read them. One store per Studio.
import type { Studio } from '../studio'

export const TRACK_H_MIN = 40
export const TRACK_H_MAX = 240
export const TRACK_H_DEFAULT = 64 // --track-h

export type Heights = {
  get(trackId: string): number
  set(trackId: string, h: number): void
  /** Called after any change. Returns the unsubscribe. */
  on(fn: () => void): () => void
}

const stores = new WeakMap<Studio, Heights>()
export const clampHeight = (h: number) => Math.round(Math.min(TRACK_H_MAX, Math.max(TRACK_H_MIN, h)))

export function heightsFor(st: Studio): Heights {
  let s = stores.get(st)
  if (s) return s
  const key = `mobdaw.trackHeights.${st.s.projectId}`
  let map: Record<string, number> = {}
  try {
    map = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>
  } catch { /* none remembered */ }
  const subs = new Set<() => void>()
  let saveTimer = 0
  s = {
    get: (id) => clampHeight(map[id] ?? TRACK_H_DEFAULT),
    set(id, h) {
      const v = clampHeight(h)
      if (map[id] === v) return
      if (v === TRACK_H_DEFAULT) delete map[id]
      else map[id] = v
      clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        try { localStorage.setItem(key, JSON.stringify(map)) } catch { /* private mode */ }
      }, 200)
      subs.forEach((f) => f())
    },
    on(fn) {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
  }
  stores.set(st, s)
  return s
}
