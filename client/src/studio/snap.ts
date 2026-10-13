// Snapping a timeline position to the musical grid (pure, so it is tested on its own).
import { snapToGrid, type GridSize, type Tempo } from '@mobdaw/shared'

/** Modifier keys held during a drag or click: alt or ctrl means "no snap". */
export type SnapMods = { altKey: boolean; ctrlKey: boolean }

/** Timeline sample `smp` on grid `g` at tempo `t`; unsnapped (but whole and not negative) while alt or ctrl is held. */
export function snapPosition(smp: number, g: GridSize, t: Tempo, rate: number, mods?: SnapMods) {
  if (mods && (mods.altKey || mods.ctrlKey)) return Math.max(0, Math.round(smp))
  return snapToGrid(smp, g, t, rate)
}
