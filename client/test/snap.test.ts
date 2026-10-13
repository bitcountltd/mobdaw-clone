import { describe, expect, it } from 'vitest'
import { snapPosition } from '../src/studio/snap'

const t = { bpm: 120, beatsPerBar: 4 }
const rate = 48000 // a beat is 24000 samples, a 1/16 is 6000

describe('snapPosition', () => {
  it('rounds to the nearest grid line', () => {
    expect(snapPosition(8999, 0.25, t, rate)).toBe(6000)
    expect(snapPosition(9001, 0.25, t, rate)).toBe(12000)
    expect(snapPosition(50000, 1, t, rate)).toBe(48000)
    expect(snapPosition(40000, 'bar', t, rate)).toBe(0)
    expect(snapPosition(60000, 'bar', t, rate)).toBe(96000)
  })
  it('follows the tempo', () => {
    expect(snapPosition(10000, 1, { bpm: 240, beatsPerBar: 4 }, rate)).toBe(12000)
  })
  it('leaves the position free with the grid off or alt / ctrl held', () => {
    expect(snapPosition(8999.4, 0, t, rate)).toBe(8999)
    expect(snapPosition(8999, 0.25, t, rate, { altKey: true, ctrlKey: false })).toBe(8999)
    expect(snapPosition(8999, 0.25, t, rate, { altKey: false, ctrlKey: true })).toBe(8999)
    expect(snapPosition(-50, 0.25, t, rate, { altKey: true, ctrlKey: false })).toBe(0)
  })
})
