// QA round 1 fixes with pure logic: MIDI split, tempo drags without drift, per-kind track names, kind-aware drops,
// friendly microphone errors, keys the computer keyboard takes.
import {
  FINNWAVE, addAudioClip, addDevice, addMidiClip, addNote, addPoint, addLane, addTrack, beginTempoChange, getClips, getLoop, getNotes,
  getPoints, setLoop, setProjectTempo, splitClip, splitMidiNotes, type MidiClip,
} from '@mobdaw/shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { DRUM_KITS, INSTRUMENT_PRESETS, addDrumKit } from '../src/content/presets'
import { isDrumTrack, kindOf, numberedName } from '../src/studio/arrange/kinds'
import { landsOn } from '../src/studio/drops'
import { NO_MIC, micErrorText } from '../src/studio/recordingCtl'
import { takenByKeys } from '../src/studio/qwerty'

const PPQ = 96 // ticks per beat in these tests; at 120 bpm and 48 kHz a beat is 24000 samples
const midiClip = (doc: Y.Doc, o: Partial<MidiClip> = {}) => {
  const trackId = addTrack(doc, 'i', 'midi')
  return addMidiClip(doc, { trackId, start: 96000, bpm: 120, ppq: PPQ, lengthTicks: 16 * PPQ, ...o })
}
const clip = (doc: Y.Doc, id: string) => getClips(doc).find((c) => c.id === id) as MidiClip
const notesOf = (doc: Y.Doc, id: string) => getNotes(doc).filter((n) => n.clipId === id).sort((a, b) => a.tick - b.tick)

describe('splitMidiNotes', () => {
  const n = (tick: number, durTicks: number) => ({ tick, durTicks })
  it('moves later notes right and cuts notes across the split', () => {
    const { left, right } = splitMidiNotes([n(0, 96), n(150, 100), n(200, 10), n(300, 50)], 200)
    expect(left).toEqual([n(0, 96), n(150, 50)])
    expect(right).toEqual([n(0, 10), n(100, 50)])
  })
  it('keeps a looping pattern on both halves, turned on the right', () => {
    const { left, right } = splitMidiNotes([n(0, 10), n(96, 10), n(400, 10)], 96 * 5, 96 * 4)
    expect(left).toEqual([n(0, 10), n(96, 10)]) // (400 is past the pattern: ignored)
    expect(right).toEqual([n(96 * 3, 10), n(0, 10)]) // the pass restarts 1 beat in
  })
})

describe('splitClip on MIDI clips', () => {
  it('splits at the playhead into two clips that play the same notes', () => {
    const doc = new Y.Doc()
    const id = midiClip(doc)
    addNote(doc, { clipId: id, tick: 0, durTicks: 96, pitch: 60, velocity: 1 })
    addNote(doc, { clipId: id, tick: 4 * 96 - 48, durTicks: 96, pitch: 62, velocity: 1 }) // crosses the split
    addNote(doc, { clipId: id, tick: 6 * 96, durTicks: 96, pitch: 64, velocity: 1 })
    const right = splitClip(doc, id, 96000 + 4 * 24000)!
    expect(right).toBeTruthy()
    expect(clip(doc, id).lengthTicks).toBe(4 * 96)
    expect(clip(doc, right)).toMatchObject({ start: 96000 + 96000, lengthTicks: 12 * 96, bpm: 120 })
    expect(notesOf(doc, id).map((x) => [x.tick, x.durTicks, x.pitch])).toEqual([[0, 96, 60], [4 * 96 - 48, 48, 62]])
    expect(notesOf(doc, right).map((x) => [x.tick, x.pitch])).toEqual([[2 * 96, 64]])
  })
  it('does nothing outside the clip', () => {
    const doc = new Y.Doc()
    const id = midiClip(doc)
    expect(splitClip(doc, id, 96000)).toBeNull()
    expect(splitClip(doc, id, 96000 + 16 * 24000)).toBeNull()
    expect(getClips(doc)).toHaveLength(1)
  })
  it('a looping clip keeps its pattern; forever goes to the right half', () => {
    const doc = new Y.Doc()
    const id = midiClip(doc, { loopTicks: 4 * 96, forever: true })
    addNote(doc, { clipId: id, tick: 0, durTicks: 48, pitch: 60, velocity: 1 })
    const right = splitClip(doc, id, 96000 + 6 * 24000)!
    expect(clip(doc, id)).toMatchObject({ lengthTicks: 6 * 96, loopTicks: 4 * 96, forever: false })
    expect(clip(doc, right)).toMatchObject({ lengthTicks: 10 * 96, loopTicks: 4 * 96, forever: true })
    expect(notesOf(doc, right).map((x) => x.tick)).toEqual([2 * 96]) // the next downbeat of the pattern, 2 beats in
  })
})

describe('beginTempoChange', () => {
  it('scales from the snapshot, so a drag back and forth does not drift', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'a')
    const a = addAudioClip(doc, { trackId: t, sourceHash: 'x', start: 96001, length: 1000 })
    const m = midiClip(doc, { start: 3 * 96000 + 7 })
    const lane = addLane(doc, { scope: t, kind: 'track', owner: t, param: 0 } as never, { min: 0, max: 1 } as never)
    addPoint(doc, lane, 123457, 0.5, 'linear')
    setLoop(doc, { start: 96000, end: 288000, on: true })
    setProjectTempo(doc, 120)
    const ch = beginTempoChange(doc)
    for (let i = 0; i < 50; i++) ch.set(97 + (i % 7) * 13.37)
    ch.set(120)
    ch.end()
    expect(getClips(doc).find((c) => c.id === a)!.start).toBe(96001)
    expect(clip(doc, m)).toMatchObject({ start: 3 * 96000 + 7, bpm: 120 })
    expect(getPoints(doc)[0].pos).toBe(123457)
    expect(getLoop(doc)).toMatchObject({ start: 96000, end: 288000 })
  })
  it('keeps clips on their bar', () => {
    const doc = new Y.Doc()
    const m = midiClip(doc, { start: 2 * 96000 })
    setProjectTempo(doc, 120)
    const ch = beginTempoChange(doc)
    ch.set(90)
    ch.set(60)
    expect(clip(doc, m)).toMatchObject({ start: 4 * 96000, bpm: 60 })
    ch.end()
    ch.set(200) // (ended: no effect)
    expect(clip(doc, m).bpm).toBe(60)
  })
})

describe('track kinds and names', () => {
  it('numbers new tracks per kind', () => {
    expect(numberedName([], 'drums')).toBe('drums 1')
    expect(numberedName(['drums 1', 'instrument 1', 'drums 2', 'Drums'], 'drums')).toBe('drums 3')
    expect(numberedName(['audio 4', 'my vocal'], 'audio')).toBe('audio 5')
    expect(numberedName(['instrument'], 'instrument')).toBe('instrument 2')
  })
  it('tells drum tracks from instrument tracks', () => {
    const doc = new Y.Doc()
    const drums = addTrack(doc, 'd', 'midi')
    addDrumKit(doc, drums, DRUM_KITS[0])
    const synth = addTrack(doc, 's', 'midi')
    addDevice(doc, synth, FINNWAVE)
    const grid = addTrack(doc, 'g', 'midi')
    addMidiClip(doc, { trackId: grid, start: 0, view: 'drums' })
    const empty = addTrack(doc, 'e', 'midi')
    const audio = addTrack(doc, 'a', 'audio')
    const k = (id: string) => kindOf(doc, { id, kind: id === audio ? 'audio' : 'midi' }).label
    expect([k(drums), k(synth), k(grid), k(empty), k(audio)]).toEqual(['drum track', 'instrument track', 'drum track', 'instrument track', 'audio track'])
    expect(isDrumTrack(empty, [], [])).toBe(false)
  })
})

describe('landsOn (drops)', () => {
  const setup = () => {
    const doc = new Y.Doc()
    const audio = addTrack(doc, 'a', 'audio')
    const synth = addTrack(doc, 's', 'midi')
    addDevice(doc, synth, FINNWAVE)
    const drums = addTrack(doc, 'd', 'midi')
    addDrumKit(doc, drums, DRUM_KITS[0])
    const empty = addTrack(doc, 'e', 'midi')
    return { doc, audio, synth, drums, empty }
  }
  const inst = { kind: 'instrument' as const, id: INSTRUMENT_PRESETS[0].id }
  const kit = { kind: 'kit' as const, id: DRUM_KITS[0].id }
  it('an instrument on an audio track or a drum track gets a new track', () => {
    const { doc, audio, synth, drums, empty } = setup()
    expect(landsOn(doc, inst, audio)).toBe(false)
    expect(landsOn(doc, inst, drums)).toBe(false)
    expect(landsOn(doc, inst, empty)).toBe(true)
    expect(landsOn(doc, inst, synth)).toBe(true)
  })
  it('a drum kit on a track with a synth gets a new track', () => {
    const { doc, audio, synth, drums, empty } = setup()
    expect(landsOn(doc, kit, synth)).toBe(false)
    expect(landsOn(doc, kit, audio)).toBe(false)
    expect(landsOn(doc, kit, drums)).toBe(true)
    expect(landsOn(doc, kit, empty)).toBe(true)
  })
  it('effects go anywhere, audio only on audio tracks', () => {
    const { doc, audio, drums } = setup()
    expect(landsOn(doc, { kind: 'effect', type: 1 }, drums)).toBe(true)
    expect(landsOn(doc, { kind: 'sample', hash: 'x' }, audio)).toBe(true)
    expect(landsOn(doc, { kind: 'sample', hash: 'x' }, drums)).toBe(false)
  })
})

describe('micErrorText', () => {
  it('never shows the raw error', () => {
    expect(micErrorText(new Error('no microphone: Requested device not found'))).toBe(NO_MIC)
    expect(micErrorText(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe(NO_MIC)
    expect(micErrorText(new Error('microphone access was denied'))).toMatch(/blocked/)
    expect(micErrorText(new Error('this browser cannot record audio'))).toMatch(/browser cannot record/)
  })
})

describe('takenByKeys', () => {
  const e = (code: string, o: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    ({ code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o })
  it('takes note keys with or without shift, M too, but not ⇧K or mod keys', () => {
    expect(takenByKeys(e('KeyS', { shiftKey: true }))).toBe(true)
    expect(takenByKeys(e('KeyM'))).toBe(true)
    expect(takenByKeys(e('KeyK', { shiftKey: true }))).toBe(false)
    expect(takenByKeys(e('KeyS', { ctrlKey: true }))).toBe(false)
    expect(takenByKeys(e('KeyB'))).toBe(false)
  })
})
