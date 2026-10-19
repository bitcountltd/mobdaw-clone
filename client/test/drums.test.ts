// The drum synth in the UI: the drum editor's choice of drum, its model-dependent knob names, its sound menu (a sound
// is all 23 params and the name, one undo step) and the browser's drum sounds dropping in as one drum.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DEVICES, DRUM_MACROS, DRUM_MODELS, DRUM_SYNTH, LOFI_DRUM, addDrum, addTrack, getDevices, getTracks, isDrum, setParam, undoScope, type TrackKind,
} from '@mobdaw/shared'
import { applyDrumSound, soundMatching, soundParams, soundStep } from '../src/content/drumPick'
import { DRUM_SOUNDS } from '../src/content/drumSounds'
import { selectedDrum } from '../src/studio/dock/rack'
import { applyDrop, landsOn } from '../src/studio/drops'
import type { Studio } from '../src/studio/studio'
import { DRUM_GROUPS, drumKnobName, drumSpan, noiseEnv } from '../src/ui/drumParts'

const PARAMS = DEVICES[DRUM_SYNTH].params
const dev = (doc: Y.Doc, id: string) => getDevices(doc).find((d) => d.id === id)!

/** Just enough of a Studio for applyDrop. */
function studio(doc: Y.Doc) {
  return {
    doc, readOnly: false, rate: 48000,
    snap: (x: number) => x,
    focus: () => {},
    trackName: (base: string) => base,
    addTrack: (kind: TrackKind, name: string) => addTrack(doc, name, kind),
  } as unknown as Studio
}

describe('drum editor', () => {
  it('shows the drum picked on the track, else its first drum synth, else its first drum', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'drums', 'midi')
    const lofi = addDrum(doc, t, { type: LOFI_DRUM })
    expect(selectedDrum(getDevices(doc), undefined)?.id).toBe(lofi)
    const a = addDrum(doc, t), b = addDrum(doc, t)
    expect(selectedDrum(getDevices(doc), undefined)?.id).toBe(a)
    expect(selectedDrum(getDevices(doc), b)?.id).toBe(b)
    expect(selectedDrum(getDevices(doc), 'gone')?.id).toBe(a) // a removed drum: back to the first
    expect(selectedDrum([], a)).toBeUndefined()
  })

  it('groups all 23 params once, and names character / timbre after the model', () => {
    const ids = DRUM_GROUPS.flatMap((g) => g.ids)
    expect([...ids].sort((x, y) => x - y)).toEqual(PARAMS.map((p) => p.id))
    expect(ids).toHaveLength(23)
    DRUM_MODELS.forEach((_, m) => {
      expect(drumKnobName(5, m)).toBe(DRUM_MACROS[m][0])
      expect(drumKnobName(6, m)).toBe(DRUM_MACROS[m][1])
    })
    expect([drumKnobName(5, 1), drumKnobName(6, 1)]).toEqual(['ratio', 'index'])
    expect(drumKnobName(5, 3.2)).toBe('spread') // (a value between models rounds, as the select does)
    expect(drumKnobName(1, 2)).toBe('pitch')
  })

  it('draws a clap as bursts and a swell as a rise, over a span that fits the longest part', () => {
    expect(noiseEnv(0, 100, 0)).toBeCloseTo(1)
    expect(noiseEnv(0, 100, 100)).toBeLessThan(0.01)
    expect(noiseEnv(2, 100, 9)).toBeLessThan(noiseEnv(2, 100, 10)) // a new burst
    expect(noiseEnv(3, 100, 10)).toBeLessThan(noiseEnv(3, 100, 90))
    const vals: Record<number, number> = { 4: 200, 7: 1, 8: 1, 12: 900, 13: 0 }
    expect(drumSpan((p) => vals[p] ?? 0)).toBeGreaterThanOrEqual(900)
    vals[8] = 0 // silent noise doesn't count
    expect(drumSpan((p) => vals[p] ?? 0)).toBeLessThan(300)
  })

  it('a sound puts all its params and its name on the drum in one undo step, and the menu then knows it', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'drums', 'midi')
    const d = addDrum(doc, t)
    const undo = new Y.UndoManager(undoScope(doc))
    setParam(doc, d, 1, 300)
    undo.stopCapturing()
    const before = { ...dev(doc, d).params }
    const s = DRUM_SOUNDS[0]
    applyDrumSound(doc, d, s)
    const want = soundParams(s)
    expect(Object.keys(want)).toHaveLength(23)
    for (const p of PARAMS) expect(dev(doc, d).params?.[p.id]).toBeCloseTo(want[String(p.id)])
    expect(dev(doc, d).name).toBe(s.name)
    expect(soundMatching(dev(doc, d))?.id).toBe(s.id)
    undo.undo()
    expect(dev(doc, d).params).toEqual(before)
    expect(dev(doc, d).name).not.toBe(s.name)
    expect(soundMatching(dev(doc, d))).toBeNull()
  })

  it('steps through the sounds of one category, wrapping round', () => {
    const s = DRUM_SOUNDS[0]
    const cat = DRUM_SOUNDS.filter((x) => x.category === s.category)
    let at = s
    for (let i = 0; i < cat.length; i++) {
      at = soundStep(at, 1)!
      expect(at.category).toBe(s.category)
    }
    expect(at.id).toBe(s.id)
    expect(soundStep(s, -1)!.id).toBe(cat.at(-1)!.id)
    expect(soundStep(null, 1)?.id).toBe(DRUM_SOUNDS[0].id)
  })
})

describe('drum sounds from the browser', () => {
  it('drop onto a MIDI track as one drum on the next free key, or make a drums track', () => {
    const doc = new Y.Doc()
    const st = studio(doc)
    const t = addTrack(doc, 'beat', 'midi')
    addDrum(doc, t) // on 36
    const s = DRUM_SOUNDS.at(-1)!
    const p = { kind: 'drum' as const, id: s.id }
    expect(landsOn(doc, p, t)).toBe(true)
    expect(applyDrop(st, p, { trackId: t })).toBe(t)
    const added = getDevices(doc).filter((d) => d.trackId === t).at(-1)!
    expect(added).toMatchObject({ type: DRUM_SYNTH, name: s.name, keyLo: 37, keyHi: 37 })
    expect(isDrum(added)).toBe(true)
    expect(soundMatching(added)?.id).toBe(s.id)
    // nowhere in particular (or an audio track): a new MIDI track of its own
    const audio = addTrack(doc, 'vox', 'audio')
    const landed = applyDrop(st, p, { trackId: audio })
    expect(landed).not.toBe(audio)
    expect(getTracks(doc).find((x) => x.id === landed)?.kind).toBe('midi')
    expect(getDevices(doc).filter((d) => d.trackId === landed).map((d) => [d.name, d.keyLo])).toEqual([[s.name, 36]])
    expect(applyDrop(st, p, {})).not.toBeNull()
  })
})
