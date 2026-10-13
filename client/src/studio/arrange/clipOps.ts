// Edits on one clip that the arrangement's handles and the dock's clip panel share: looping, the pass, trimming.
import { getSamples, isLooping, updateClip, updateNote, type Clip, type Note } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { clamp, rotatePhase, rotateTick, trimBlock, trimMidiLeft } from '../../ui/blocks'

export const MIN_SEC = 0.05

/** The source's length in frames (audio clips can't reach past it); infinite for MIDI and unknown sources. */
export const sourceFrames = (doc: Y.Doc, c: Clip, rate: number) =>
  (c.kind === 'audio' ? (getSamples(doc)[c.sourceHash]?.duration ?? Infinity) * rate : Infinity)

/** The fields that make a non-looping clip's current length its pass, dropping any stale pass first (its phase moves into the source offset). */
export function startPass(clip: Clip & { kind: 'audio' }, srcFrames: number) {
  const sourceOffset = clip.sourceOffset + (clip.loopLength ? clip.loopPhase ?? 0 : 0)
  return { sourceOffset, loopLength: Math.min(clip.length, srcFrames - sourceOffset), loopPhase: 0 }
}

/**
 * Drag a clip's right edge to change its extent to `extent` samples; the pass repeats to fill it. A clip that wasn't
 * looping starts to, with its current length as the pass. Dragging it back to a pass or less ends the loop (isLooping),
 * and a `forever` clip stops being forever.
 */
export function loopClip(doc: Y.Doc, rate: number, clip: Clip, extent: number, srcFrames: number) {
  const looping = isLooping(clip)
  const forever = clip.forever ? { forever: false } : {}
  if (clip.kind === 'audio') {
    updateClip(doc, clip.id, { length: Math.max(Math.round(MIN_SEC * rate), Math.round(extent)), ...(looping ? {} : startPass(clip, srcFrames)), ...forever })
    return
  }
  const step = clip.ppq / 4
  const lengthTicks = Math.max(step, Math.round((extent * clip.bpm * clip.ppq) / (60 * rate) / step) * step)
  updateClip(doc, clip.id, { lengthTicks, ...(looping ? {} : { loopTicks: clip.lengthTicks }), ...forever })
}

/** Drag a looping clip's first seam: the pass becomes `pass` samples (audio) or ticks' worth (MIDI, in 1/16 steps) and the repeats re-tile. */
export function passClip(doc: Y.Doc, rate: number, clip: Clip, pass: number, srcFrames: number) {
  if (clip.kind === 'audio') {
    const lo = Math.round(MIN_SEC * rate) + (clip.loopPhase ?? 0) // the first seam stays after the clip's start
    updateClip(doc, clip.id, { loopLength: Math.round(clamp(pass, lo, Math.max(lo, Math.min(clip.length, srcFrames - clip.sourceOffset)))) })
    return
  }
  const step = clip.ppq / 4
  updateClip(doc, clip.id, { loopTicks: clamp(Math.round((pass * clip.bpm * clip.ppq) / (60 * rate) / step) * step, step, clip.lengthTicks) })
}

/**
 * Resize a clip from either edge, non-destructively (the source audio and the notes stay whole;
 * dragging the edge back out restores them). `dSmp` is the pointer delta since the grab.
 */
export function trimClip(doc: Y.Doc, rate: number, clip: Clip, mode: 'l' | 'r', dSmp: number, srcFrames: number, notes0: Note[]) {
  const minLength = MIN_SEC * rate
  if (clip.kind === 'audio') {
    if (isLooping(clip)) { // the left edge turns the pass instead (the seams stay put); the right edge is the loop handle
      const t = trimBlock('l', clip, dSmp, { minLength, slackLeft: clip.start })
      updateClip(doc, clip.id, { start: t.start, length: t.length, loopPhase: rotatePhase(clip.loopPhase ?? 0, t.d, clip.loopLength!) })
      return
    }
    // a stale pass (the clip was pulled back to a pass or less) goes, so trimming it longer can't start it looping
    const stale = clip.loopLength ? { loopLength: 0, loopPhase: 0 } : {}
    const sourceOffset = clip.sourceOffset + (clip.loopLength ? clip.loopPhase ?? 0 : 0)
    const t = trimBlock(mode, clip, dSmp, { minLength, slackLeft: Math.min(sourceOffset, clip.start), maxLength: srcFrames - sourceOffset })
    updateClip(doc, clip.id, { ...stale, ...(mode === 'l' ? { start: t.start, length: t.length, sourceOffset: sourceOffset + t.d } : { length: t.length, sourceOffset }) })
    return
  }
  // MIDI: lengths are in ticks, snapped to 1/16 notes
  const k = (clip.bpm * clip.ppq) / (60 * rate) // ticks per sample
  const step = clip.ppq / 4
  const dTicks = dSmp * k
  if (mode === 'r') {
    updateClip(doc, clip.id, { lengthTicks: Math.max(step, Math.round((clip.lengthTicks + dTicks) / step) * step), loopTicks: 0 }) // (clears a stale pass)
    return
  }
  // Left edge: the start moves and every note moves back by the same ticks, so the music stays put on the
  // timeline. Notes pushed before the new start go silent but are kept, and return if the edge is dragged out.
  // A looping clip's pattern turns instead: the notes rotate within the loop, so every repeat stays where it was.
  const t = trimMidiLeft(clip, dSmp, rate)
  const loop = isLooping(clip) ? clip.loopTicks! : 0
  doc.transact(() => {
    updateClip(doc, clip.id, { start: t.start, lengthTicks: t.lengthTicks })
    for (const n of notes0) updateNote(doc, n.id, { tick: loop && n.tick < loop ? rotateTick(n.tick, t.d, loop) : n.tick - t.d })
  })
}

/** Start looping (the current length becomes the pass; the extent grows to two of them, or runs on with `forever`). */
export function setLoopOn(doc: Y.Doc, rate: number, clip: Clip, forever: boolean) {
  if (isLooping(clip)) return updateClip(doc, clip.id, { forever })
  if (clip.kind === 'audio') updateClip(doc, clip.id, { ...startPass(clip, sourceFrames(doc, clip, rate)), length: clip.length * 2, forever })
  else updateClip(doc, clip.id, { loopTicks: clip.lengthTicks, lengthTicks: clip.lengthTicks * 2, forever })
}

/** Stop looping: the extent goes back to the first pass. */
export function setLoopOff(doc: Y.Doc, clip: Clip) {
  if (!isLooping(clip)) return
  if (clip.kind === 'audio') updateClip(doc, clip.id, { sourceOffset: clip.sourceOffset + (clip.loopPhase ?? 0), length: clip.loopLength! - (clip.loopPhase ?? 0), loopLength: 0, loopPhase: 0, forever: false })
  else updateClip(doc, clip.id, { lengthTicks: clip.loopTicks!, loopTicks: 0, forever: false })
}

