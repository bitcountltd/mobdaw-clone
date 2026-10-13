import {
  addAudioClip, addDevice, addLane, addMidiClip, addNote, addPoint, addSample, addTrack, getClips, getDevices, getLanes, getNotes, getPoints,
  getTracks, setParam, FINNWAVE,
} from '@mobdaw/shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  copyClips, cutClips, deleteClips, duplicateClips, duplicateTrack, moveGroup, nudgeClips, pasteClips, span, timelineClips,
} from '../src/studio/clipboard'

const rate = 48000

function setup() {
  const doc = new Y.Doc()
  addSample(doc, { hash: 'h1', name: 'kick.wav', duration: 2, size: 10, mime: 'audio/wav' })
  const a = addTrack(doc, 'a', 'audio')
  const m = addTrack(doc, 'm', 'midi')
  const b = addTrack(doc, 'b', 'audio')
  const ac = addAudioClip(doc, { trackId: a, sourceHash: 'h1', start: 1000, length: 48000 })
  const mc = addMidiClip(doc, { trackId: m, start: 4000, bpm: 120, ppq: 960, lengthTicks: 3840 })
  addNote(doc, { clipId: mc, tick: 0, durTicks: 480, pitch: 60, velocity: 100 })
  addNote(doc, { clipId: mc, tick: 960, durTicks: 480, pitch: 64, velocity: 90 })
  return { doc, a, m, b, ac, mc }
}
const clip = (doc: Y.Doc, id: string) => getClips(doc).find((c) => c.id === id)!

describe('copy and paste', () => {
  it('copies clips with their notes and pastes them at a position on the original tracks', () => {
    const { doc, a, m, ac, mc } = setup()
    const data = copyClips(doc, [ac, mc])!
    expect(data.origin).toBe(1000)
    expect(data.items).toHaveLength(2)
    const ids = pasteClips(doc, data, { at: 100000 })
    expect(ids).toHaveLength(2)
    const [pa, pm] = ids.map((id) => clip(doc, id))
    expect(pa).toMatchObject({ trackId: a, start: 100000, kind: 'audio', sourceHash: 'h1', length: 48000 })
    expect(pm).toMatchObject({ trackId: m, start: 103000, kind: 'midi', lengthTicks: 3840 })
    expect(getNotes(doc).filter((n) => n.clipId === pm.id).map((n) => n.pitch).sort()).toEqual([60, 64])
  })
  it('pastes onto the focused track, keeping the rows below it, and falls back to the clip\'s own track on a kind mismatch', () => {
    const { doc, a, m, b, ac, mc } = setup()
    const data = copyClips(doc, [ac])!
    const [one] = pasteClips(doc, data, { at: 0, trackId: b })
    expect(clip(doc, one).trackId).toBe(b)
    const [two] = pasteClips(doc, data, { at: 0, trackId: m }) // audio can't go on the MIDI track
    expect(clip(doc, two).trackId).toBe(a)
    const both = copyClips(doc, [ac, mc])!
    // a -> b would put the MIDI clip one row below b: there is none, so it stays on m
    const ids = pasteClips(doc, both, { at: 0, trackId: b })
    expect(ids.map((id) => clip(doc, id).trackId)).toEqual([b, m])
  })
  it('skips audio clips whose audio is not in the project', () => {
    const { doc, ac } = setup()
    const data = copyClips(doc, [ac])!
    const other = new Y.Doc()
    addTrack(other, 'x', 'audio')
    expect(pasteClips(other, data, { at: 0 })).toEqual([])
  })
  it('cut removes the clips and keeps the data; paste is one undo step', () => {
    const { doc, ac, mc } = setup()
    const um = new Y.UndoManager([doc.getMap('clips'), doc.getMap('notes')])
    const data = cutClips(doc, [ac, mc])!
    expect(getClips(doc)).toHaveLength(0)
    expect(getNotes(doc)).toHaveLength(0)
    um.stopCapturing()
    pasteClips(doc, data, { at: 0 })
    expect(getClips(doc)).toHaveLength(2)
    expect(getNotes(doc)).toHaveLength(2)
    um.undo()
    expect(getClips(doc)).toHaveLength(0)
  })
})

describe('duplicate, nudge, move, delete', () => {
  it('duplicates a selection right after itself', () => {
    const { doc, ac, mc } = setup()
    const s = span(doc, [ac, mc], rate)!
    expect(s).toEqual({ start: 1000, end: 100000 }) // the MIDI clip is 4 beats at 120 bpm: 96000 samples
    const ids = duplicateClips(doc, [ac, mc], rate)
    expect(ids.map((id) => clip(doc, id).start)).toEqual([100000, 103000])
  })
  it('nudges together and stops the group at 0', () => {
    const { doc, ac, mc } = setup()
    nudgeClips(doc, [ac, mc], 500)
    expect([clip(doc, ac).start, clip(doc, mc).start]).toEqual([1500, 4500])
    nudgeClips(doc, [ac, mc], -10000)
    expect([clip(doc, ac).start, clip(doc, mc).start]).toEqual([0, 3000])
  })
  it('moves a group by rows, keeping clips off tracks of the wrong kind', () => {
    const { doc, a, m, b, ac, mc } = setup()
    const from = new Map([[ac, { start: 1000, trackId: a }], [mc, { start: 4000, trackId: m }]])
    moveGroup(doc, from, 2000, 2)
    expect(clip(doc, ac)).toMatchObject({ start: 3000, trackId: b })
    expect(clip(doc, mc)).toMatchObject({ start: 6000, trackId: m }) // two rows below m: no track
  })
  it('deletes clips and their notes', () => {
    const { doc, ac, mc } = setup()
    deleteClips(doc, [ac, mc])
    expect(getClips(doc)).toHaveLength(0)
    expect(getNotes(doc)).toHaveLength(0)
  })
  it('lists the main timeline clips (not soundscape sources)', () => {
    const { doc, ac, mc } = setup()
    const sc = addTrack(doc, 's', 'soundscape')
    addAudioClip(doc, { trackId: sc, sourceHash: 'h1', start: 0, length: 10 })
    expect(timelineClips(doc).sort()).toEqual([ac, mc].sort())
  })
})

describe('duplicateTrack', () => {
  it('copies the track below itself with devices, params, clips, notes and automation', () => {
    const { doc, m, mc } = setup()
    const dev = addDevice(doc, m, FINNWAVE)
    setParam(doc, dev, 0, 0.42)
    const lane = addLane(doc, { scope: m, kind: 'device', owner: dev, param: 0 })
    addPoint(doc, lane, 0, 0.5)
    const id = duplicateTrack(doc, m)!
    const tracks = getTracks(doc)
    expect(tracks.map((t) => t.name)).toEqual(['a', 'm', 'm copy', 'b'])
    const copy = getDevices(doc).find((d) => d.trackId === id)!
    expect(copy.type).toBe(FINNWAVE)
    expect(copy.params['0']).toBe(0.42)
    const clips = getClips(doc).filter((c) => c.trackId === id)
    expect(clips).toHaveLength(1)
    expect(clips[0].id).not.toBe(mc)
    expect(getNotes(doc).filter((n) => n.clipId === clips[0].id)).toHaveLength(2)
    const l2 = getLanes(doc).find((l) => l.scope === id)!
    expect(l2.owner).toBe(copy.id)
    expect(getPoints(doc).filter((p) => p.laneId === l2.id)).toHaveLength(1)
  })
})
