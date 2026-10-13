// What the automation lanes say, as of the last document change and the playhead: the lanes and their sorted points (the
// arrangement draws them), and what each automated param reads at the playhead (the device and looper cards show it).
import { evalPoints, getLanes, getPoints, laneState, paramToValue, resolveTarget, type Lane, type Point } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { NO_AUTO, type AutoInfo } from '../ui/automation'

export class AutoState {
  lanes: Lane[] = []
  /** Lane id -> its points, sorted by position. */
  points = new Map<string, Point[]>()
  /** Owner (device or looper) id -> param -> what drives it. */
  infos = new Map<string, Map<string, AutoInfo>>()

  /** Read the lanes and their points from the doc, and what they drive at `at`. */
  load(doc: Y.Doc, at: number) {
    this.lanes = getLanes(doc)
    this.points = new Map()
    for (const p of getPoints(doc)) (this.points.get(p.laneId) ?? this.points.set(p.laneId, []).get(p.laneId)!).push(p)
    for (const list of this.points.values()) list.sort((a, b) => a.pos - b.pos)
    this.read(doc, at)
  }

  /**
   * What each automated param reads at `at`. An LFO lane drives nothing: its control stays free, as the wave's centre.
   * Cheap enough to run every frame while playing.
   */
  read(doc: Y.Doc, at: number) {
    this.infos = new Map()
    for (const l of this.lanes) {
      const r = resolveTarget(doc, l)
      if (!r) continue
      const t = laneState(l) === 'lfo' ? null : evalPoints(this.points.get(l.id) ?? [], at)
      ;(this.infos.get(l.owner) ?? this.infos.set(l.owner, new Map()).get(l.owner)!).set(l.param, { on: l.enabled && t != null, value: t == null ? null : paramToValue(r.def, t) })
    }
  }

  info(owner: string): Map<string, AutoInfo> {
    return this.infos.get(owner) ?? NO_AUTO
  }
}
