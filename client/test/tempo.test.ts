// Tempo math, the loop helpers and the drawn grid (shared/src/tempo.ts, studio/arrange/grid.ts).
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addAudioClip, addClickTrack, addMidiClip, addTrack, barsBeats, fitClickTrack, formatBarsBeats, getClips, getLoop, getNotes, getTempo,
  loopAround, loopBetween, metaMap, samplesPerBar, setBeatsPerBar, setLoop, setProjectTempo, snapToGrid, tapBpm, toggledLoop,
  visibleGridBeats, type MidiClip,
} from '@mobdaw/shared'
import { gridLevels, laneGridCss, rulerTicks } from '../src/studio/arrange/grid'

const rate = 48000
const t = { bpm: 120, beatsPerBar: 4 } // a beat is 24000 samples, a bar 96000, a 1/16 6000

describe('barsBeats', () => {
  it('counts from 1.1.1', () => {
    expect(barsBeats(0, t, rate)).toEqual({ bar: 1, beat: 1, sixteenth: 1 })
    expect(barsBeats(6000, t, rate)).toEqual({ bar: 1, beat: 1, sixteenth: 2 })
    expect(barsBeats(24000, t, rate)).toEqual({ bar: 1, beat: 2, sixteenth: 1 })
    expect(barsBeats(96000 * 11 + 24000 * 2 + 6000, t, rate)).toEqual({ bar: 12, beat: 3, sixteenth: 2 })
  })
  it('is exact on a downbeat despite rounding (no 1.4.4 just before bar 2)', () => {
    const bar = samplesPerBar({ bpm: 88, beatsPerBar: 4 }, rate) // fractional samples per bar
    expect(barsBeats(Math.round(bar * 7), { bpm: 88, beatsPerBar: 4 }, rate).bar).toBe(8)
    // every rounded (or floored) bar line at 88 bpm, 44.1 and 48 kHz, reads as that bar's 1.1, never the bar before
    for (const r of [44100, 48000]) {
      const t88 = { bpm: 88, beatsPerBar: 4 }
      const b = samplesPerBar(t88, r)
      for (let k = 1; k < 200; k++) {
        for (const p of [Math.round(b * k), Math.floor(b * k)]) expect(formatBarsBeats(p, t88, r)).toBe(`${k + 1}.1.1`)
      }
    }
    expect(formatBarsBeats(Math.round(samplesPerBar({ bpm: 88, beatsPerBar: 4 }, rate) * 4) - 10, { bpm: 88, beatsPerBar: 4 }, rate)).toBe('4.4.4')
  })
  it('follows the meter', () => {
    expect(formatBarsBeats(72000, { bpm: 120, beatsPerBar: 3 }, rate)).toBe('2.1.1')
    expect(formatBarsBeats(-5, t, rate)).toBe('1.1.1')
  })
})

describe('snapToGrid', () => {
  it('rounds to the nearest line of each grid size', () => {
    expect(snapToGrid(8999, 0.25, t, rate)).toBe(6000)
    expect(snapToGrid(9001, 0.25, t, rate)).toBe(12000)
    expect(snapToGrid(3100, 0.125, t, rate)).toBe(3000)
    expect(snapToGrid(13000, 0.5, t, rate)).toBe(12000)
    expect(snapToGrid(50000, 1, t, rate)).toBe(48000)
    expect(snapToGrid(60000, 'bar', t, rate)).toBe(96000)
  })
  it('is free when the grid is off, and never negative', () => {
    expect(snapToGrid(1234.4, 0, t, rate)).toBe(1234)
    expect(snapToGrid(-4000, 0.25, t, rate)).toBe(0)
  })
})

describe('visibleGridBeats', () => {
  it('gets coarser as the zoom goes out, in beats then whole bars', () => {
    expect(visibleGridBeats(t, 800)).toBe(0.125) // a 1/32 is 50 px
    expect(visibleGridBeats(t, 80)).toBe(0.5) // a beat is 40 px, an eighth 20
    expect(visibleGridBeats(t, 40)).toBe(1) // a beat is 20 px, an eighth 10
    expect(visibleGridBeats(t, 20)).toBe(4) // a beat is 10 px: whole bars (40 px)
    expect(visibleGridBeats(t, 1)).toBe(32) // a bar is 2 px: every 8 bars (16 px)
  })
})

describe('setProjectTempo', () => {
  function song() {
    const doc = new Y.Doc()
    metaMap(doc).set('bpm', 120)
    const a = addTrack(doc, 'audio')
    const m = addTrack(doc, 'keys', 'midi')
    const audio = addAudioClip(doc, { trackId: a, sourceHash: 'h', start: 96000 * 2, length: 30000 }) // bar 3
    const midi = addMidiClip(doc, { trackId: m, start: 96000 * 4 + 24000, bpm: 120 }) // bar 5 beat 2
    setLoop(doc, { start: 96000, end: 96000 * 3, on: true })
    return { doc, audio, midi }
  }
  it('keeps every clip on its bar and beat, and MIDI clips take the new bpm', () => {
    const { doc, audio, midi } = song()
    setProjectTempo(doc, 90)
    const nt = getTempo(doc)
    expect(nt.bpm).toBe(90)
    const clips = new Map(getClips(doc).map((c) => [c.id, c]))
    expect(barsBeats(clips.get(audio)!.start, nt, rate)).toEqual({ bar: 3, beat: 1, sixteenth: 1 })
    expect(barsBeats(clips.get(midi)!.start, nt, rate)).toEqual({ bar: 5, beat: 2, sixteenth: 1 })
    expect((clips.get(midi) as MidiClip).bpm).toBe(90)
    expect(clips.get(audio)!.kind === 'audio' && clips.get(audio)!.length).toBe(30000) // audio is not stretched
    const loop = getLoop(doc)!
    expect(barsBeats(loop.start, nt, rate).bar).toBe(2)
    expect(barsBeats(loop.end, nt, rate).bar).toBe(4)
  })
  it('is one undo step and clamps the range', () => {
    const { doc } = song()
    const undo = new Y.UndoManager([metaMap(doc), doc.getMap('clips')])
    setProjectTempo(doc, 1000)
    expect(getTempo(doc).bpm).toBe(300)
    undo.undo()
    expect(getTempo(doc).bpm).toBe(120)
  })
})

describe('click track', () => {
  it('follows the project tempo and meter', () => {
    const doc = new Y.Doc()
    metaMap(doc).set('bpm', 88)
    const id = addClickTrack(doc)
    fitClickTrack(doc)
    const clip = getClips(doc).find((c) => c.trackId === id) as MidiClip
    expect(clip.bpm).toBe(88)
    setBeatsPerBar(doc, 3)
    const c3 = getClips(doc).find((c) => c.trackId === id) as MidiClip
    expect(c3.loopTicks).toBe(3 * c3.ppq)
    const notes = getNotes(doc).filter((n) => n.clipId === c3.id)
    expect(notes.filter((n) => n.tick < c3.loopTicks!).map((n) => n.tick).sort((a, b) => a - b)).toEqual([0, 0, c3.ppq, 2 * c3.ppq])
  })
})

describe('loop helpers', () => {
  it('loopAround takes the 4-bar phrase around a position', () => {
    expect(loopAround(96000 * 5 + 10, t, rate)).toEqual({ start: 96000 * 4, end: 96000 * 8, on: true })
    expect(loopAround(0, t, rate, 1)).toEqual({ start: 0, end: 96000, on: true })
  })
  it('toggledLoop switches an existing region, else makes one over the selection (to the grid) or the bars around', () => {
    const cur = { start: 10, end: 20, on: true }
    expect(toggledLoop(cur, 0, t, rate)).toEqual({ ...cur, on: false })
    expect(toggledLoop(null, 0, t, rate, { start: 7000, end: 50000 }, 6000)).toEqual({ start: 6000, end: 54000, on: true })
    expect(toggledLoop(null, 96000 * 2, t, rate, null)).toEqual({ start: 0, end: 96000 * 4, on: true })
  })
  it('loopBetween orders the ends and keeps a minimum length', () => {
    expect(loopBetween(500, 100, 10)).toEqual({ start: 100, end: 500, on: true })
    expect(loopBetween(100, 100, 6000, false)).toEqual({ start: 100, end: 6100, on: false })
  })
  it('tapBpm averages the recent taps', () => {
    expect(tapBpm([0])).toBeNull()
    expect(tapBpm([0, 500, 1000, 1500])).toBe(120)
    expect(tapBpm([0, 1, 2])).toBe(300)
  })
})

describe('grid drawing', () => {
  it('draws bars always, beats and sub-beats once they are far enough apart', () => {
    expect(gridLevels(t, 10)).toMatchObject({ bar: 4, beat: 0, sub: 0 })
    expect(gridLevels(t, 80)).toMatchObject({ bar: 4, beat: 1, sub: 0.5 })
    expect(gridLevels(t, 400, 0.25)).toMatchObject({ bar: 4, beat: 1, sub: 0.25 })
    expect(gridLevels(t, 2)).toMatchObject({ beat: 0, sub: 0 })
    expect(gridLevels(t, 2).bar).toBeGreaterThan(4)
  })
  it('labels bars from 1, skipping bars when zoomed out', () => {
    const near = rulerTicks(t, 80, 0, 4 * 160) // a bar is 160 px
    expect(near.filter((k) => k.label).map((k) => k.label)).toEqual(['1', '2', '3', '4', '5'])
    const far = rulerTicks(t, 5, 0, 32 * 10) // a bar is 10 px: every 4 bars
    expect(far.filter((k) => k.label).map((k) => k.label)).toEqual(['1', '5', '9', '13', '17', '21', '25', '29', '33'])
  })
  it('puts the lines where the clips are (same samples -> px mapping), with no drift', () => {
    const tt = { bpm: 88, beatsPerBar: 4 }
    const pps = 137.3
    const bar31 = 30 * samplesPerBar(tt, rate)
    const tick = rulerTicks(tt, pps, 0, 1e6).find((k) => k.label === '31')!
    expect(Math.abs(tick.px - (bar31 / rate) * pps)).toBeLessThan(1e-6)
    expect(laneGridCss(tt, rate, pps, 0.25, null)).toContain(`transparent 1px ${+((4 * 60 / 88) * pps).toFixed(4)}px`)
  })
  it('adds the loop band', () => {
    const css = laneGridCss(t, rate, 100, 0.25, { start: 48000, end: 96000, on: true })
    expect(css).toContain('var(--loop-band) 100px 200px')
  })
})
