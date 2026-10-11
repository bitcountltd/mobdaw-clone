import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addAudioClip, addMidiClip, addPad, addTrack, updateClip, updateTrack } from '@mobdaw/shared'
import { contentEnd, contentStart } from '../src/audio/range'

const SR = 48000
const BAR = 4 * 960 // ticks; at 120 bpm 2 s

describe('export range', () => {
  const setup = () => {
    const doc = new Y.Doc()
    const click = addTrack(doc, 'click', 'midi', undefined, 'click')
    const song = addTrack(doc, 'song')
    const other = addTrack(doc, 'other')
    // a one-bar count-in on the click track, the song from bar 2 to bar 4, something else from bar 1 to bar 6
    addMidiClip(doc, { trackId: click, start: 0, lengthTicks: BAR, bpm: 120 })
    addAudioClip(doc, { trackId: song, sourceHash: 'h', start: 2 * SR, length: 4 * SR })
    addAudioClip(doc, { trackId: other, sourceHash: 'h', start: 0, length: 10 * SR })
    return { doc, click, song, other }
  }

  it('covers every clip while nothing is muted or soloed', () => {
    const { doc } = setup()
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([0, 10 * SR])
  })

  it('skips muted tracks: a muted count-in is trimmed off the front, a muted tail off the end', () => {
    const { doc, click, other } = setup()
    updateTrack(doc, click, { muted: true })
    updateTrack(doc, other, { muted: true })
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([2 * SR, 6 * SR])
  })

  it('with a track soloed only it and the click track count, and a muted click never does', () => {
    const { doc, click, song } = setup()
    updateTrack(doc, song, { soloed: true })
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([0, 6 * SR]) // the click's count-in is audible
    updateTrack(doc, click, { muted: true })
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([2 * SR, 6 * SR])
  })

  it('a looping MIDI clip counts at its full extent, and pads follow their track', () => {
    const { doc, click, other } = setup()
    const loop = addMidiClip(doc, { trackId: click, start: 20 * SR, lengthTicks: 4 * BAR, loopTicks: BAR, bpm: 120 })
    expect(contentEnd(doc, SR)).toBe(28 * SR) // 4 bars of 2 s
    updateClip(doc, loop, { loopTicks: 0 })
    expect(contentEnd(doc, SR)).toBe(28 * SR)
    const scape = addTrack(doc, 'scape', 'soundscape')
    addPad(doc, scape, 30 * SR, 2 * SR)
    expect(contentEnd(doc, SR)).toBe(32 * SR)
    updateTrack(doc, scape, { muted: true })
    updateTrack(doc, other, { soloed: true })
    expect(contentEnd(doc, SR)).toBe(28 * SR) // (the click's loop still counts; the muted soundscape does not)
  })

  it('is empty when nothing is audible', () => {
    const doc = new Y.Doc()
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([0, 0])
  })
})
