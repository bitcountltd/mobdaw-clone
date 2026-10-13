import { describe, expect, it } from 'vitest'
import {
  barsText, clampVelocity, floorTick, gridTicks, inMarquee, nextVelocity, nudgeVelocity, quantize, setVelocity, shift, snapTick, transpose, velocityAt,
} from '../src/studio/dock/noteOps'

const n = (id: string, tick: number, pitch = 60, durTicks = 480, velocity = 0.8) => ({ id, clipId: 'c', tick, pitch, durTicks, velocity })
const PPQ = 960

describe('grid ticks', () => {
  it('turns grid sizes into ticks', () => {
    expect(gridTicks(0.25, PPQ, 4)).toBe(240)
    expect(gridTicks(1, PPQ, 4)).toBe(960)
    expect(gridTicks('bar', PPQ, 3)).toBe(2880)
    expect(gridTicks(0, PPQ, 4)).toBe(0)
  })
  it('snaps and floors', () => {
    expect(snapTick(119, 240)).toBe(0)
    expect(snapTick(121, 240)).toBe(240)
    expect(snapTick(121.4, 0)).toBe(121)
    expect(floorTick(479, 240)).toBe(240)
  })
})

describe('quantize', () => {
  it('moves starts to the nearest line and keeps lengths', () => {
    const p = quantize([n('a', 250), n('b', 470, 60, 100), n('c', 480)], 240)
    expect(p).toEqual([{ id: 'a', tick: 240 }, { id: 'b', tick: 480 }])
  })
  it('goes part of the way with a strength', () => {
    expect(quantize([n('a', 300)], 240, 0.5)).toEqual([{ id: 'a', tick: 270 }])
  })
  it('stretches short notes to a step when asked', () => {
    expect(quantize([n('a', 240, 60, 30)], 240, 1, true)).toEqual([{ id: 'a', durTicks: 240 }])
  })
  it('does nothing with the grid off', () => {
    expect(quantize([n('a', 251)], 0)).toEqual([])
  })
})

describe('transpose and shift', () => {
  it('moves every note by the interval', () => {
    expect(transpose([n('a', 0, 60), n('b', 0, 64)], 12)).toEqual([{ id: 'a', pitch: 72 }, { id: 'b', pitch: 76 }])
  })
  it('refuses a move past the range', () => {
    expect(transpose([n('a', 0, 100), n('b', 0, 60)], 12)).toBeNull()
    expect(transpose([n('a', 0, 13)], -2)).toBeNull()
  })
  it('shifts in time without going before the clip start', () => {
    expect(shift([n('a', 240), n('b', 960)], -480)).toEqual([{ id: 'a', tick: 0 }, { id: 'b', tick: 720 }])
    expect(shift([n('a', 0)], -240)).toEqual([])
  })
})

describe('velocity', () => {
  it('clamps', () => {
    expect(clampVelocity(1.4)).toBe(1)
    expect(clampVelocity(0)).toBe(0.05)
  })
  it('reads a lane height', () => {
    expect(velocityAt(0, 50)).toBe(1)
    expect(velocityAt(25, 50)).toBe(0.5)
    expect(velocityAt(80, 50)).toBe(0.05)
  })
  it('sets and nudges', () => {
    expect(setVelocity([n('a', 0, 60, 480, 0.5), n('b', 0, 60, 480, 1)], 1)).toEqual([{ id: 'a', velocity: 1 }])
    expect(nudgeVelocity([n('a', 0, 60, 480, 0.9)], 0.2)).toEqual([{ id: 'a', velocity: 1 }])
  })
  it('cycles the drum grid steps', () => {
    expect(nextVelocity(1)).toBe(0.75)
    expect(nextVelocity(0.75)).toBe(0.5)
    expect(nextVelocity(0.25)).toBe(1)
    expect(nextVelocity(0.6)).toBe(0.25)
  })
})

describe('marquee', () => {
  it('takes notes that overlap the box', () => {
    const notes = [n('a', 0, 60, 480), n('b', 960, 62, 480), n('c', 0, 70, 480)]
    expect(inMarquee(notes, 400, 1000, 59, 63).map((x) => x.id)).toEqual(['a', 'b'])
    expect(inMarquee(notes, 1000, 400, 63, 59).map((x) => x.id)).toEqual(['a', 'b'])
    expect(inMarquee(notes, 480, 900, 0, 127)).toEqual([])
  })
})

describe('barsText', () => {
  it('formats bars', () => {
    expect(barsText(4 * 4 * PPQ, PPQ, 4)).toBe('4')
    expect(barsText(6 * PPQ, PPQ, 4)).toBe('1.5')
  })
})
