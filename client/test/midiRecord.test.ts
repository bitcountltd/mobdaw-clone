import { describe, expect, it } from 'vitest'
import { barStart, buildTake, type TimedNote } from '../src/studio/midiRecord'

const rate = 48000, bpm = 120, beatsPerBar = 4, ppq = 960
const beat = rate / 2, bar = 4 * beat // 120 bpm: a beat is half a second
const o = (from: number, end: number) => ({ from, end, rate, bpm, beatsPerBar, ppq })
const on = (pitch: number, at: number, velocity = 0.8): TimedNote => ({ pitch, velocity, on: true, at })
const off = (pitch: number, at: number): TimedNote => ({ pitch, velocity: 0, on: false, at })

describe('buildTake', () => {
  it('starts the clip at the bar of the record position', () => {
    expect(barStart(bar * 2 + 100, o(0, 0))).toBe(bar * 2)
    const t = buildTake([on(60, bar * 2 + beat), off(60, bar * 2 + 2 * beat)], o(bar * 2 + 100, bar * 3 - 10))!
    expect(t.start).toBe(bar * 2)
    expect(t.notes).toEqual([{ tick: ppq, durTicks: ppq, pitch: 60, velocity: 0.8 }])
    expect(t.lengthTicks).toBe(4 * ppq)
  })
  it('rounds the length up to whole bars, covering the stop position', () => {
    const t = buildTake([on(60, 0), off(60, beat)], o(0, bar + beat))!
    expect(t.lengthTicks).toBe(8 * ppq)
  })
  it('pairs repeated pitches in order and closes held notes at the end', () => {
    const t = buildTake([on(60, 0), on(64, 0), off(60, beat), on(60, 2 * beat), off(60, 3 * beat)], o(0, 4 * beat))!
    expect(t.notes.map((n) => [n.pitch, n.tick, n.durTicks])).toEqual([[60, 0, ppq], [64, 0, 4 * ppq], [60, 2 * ppq, ppq]])
  })
  it('gives taps a minimum length and clamps early notes to the clip start', () => {
    const t = buildTake([on(60, -200), off(60, -100)], o(0, beat))!
    expect(t.notes[0].tick).toBe(0)
    expect(t.notes[0].durTicks).toBe(ppq / 32)
  })
  it('returns null with no notes', () => {
    expect(buildTake([], o(0, bar))).toBeNull()
    expect(buildTake([off(60, 10)], o(0, bar))).toBeNull()
  })
})
