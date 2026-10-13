import { describe, expect, it } from 'vitest'
import { qwertyPitch, stepVelocity } from '../src/studio/qwerty'
import { parseNote } from '../src/midi'

describe('computer keyboard', () => {
  it('maps the A row to white keys and the Q row to black keys from middle C', () => {
    const codes = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon', 'Quote']
    expect(codes.map((c) => qwertyPitch(c, 0))).toEqual(Array.from({ length: 18 }, (_, i) => 60 + i))
    expect(qwertyPitch('KeyQ', 0)).toBeNull()
    expect(qwertyPitch('KeyZ', 0)).toBeNull()
  })
  it('shifts by octaves and stays in range', () => {
    expect(qwertyPitch('KeyA', -2)).toBe(36)
    expect(qwertyPitch('KeyA', 1)).toBe(72)
    expect(qwertyPitch('Quote', 6)).toBeNull()
  })
  it('steps velocity', () => {
    expect(stepVelocity(100, 1)).toBe(127)
    expect(stepVelocity(127, 1)).toBe(127)
    expect(stepVelocity(100, -1)).toBe(80)
    expect(stepVelocity(20, -1)).toBe(20)
    expect(stepVelocity(90, -1)).toBe(80)
  })
})

describe('MIDI notes', () => {
  it('parses note-on, note-off and velocity-0 note-ons', () => {
    expect(parseNote([0x91, 60, 100])).toEqual({ on: true, channel: 1, pitch: 60, velocity: 100 })
    expect(parseNote([0x80, 60, 40])).toEqual({ on: false, channel: 0, pitch: 60, velocity: 0 })
    expect(parseNote([0x90, 60, 0])).toEqual({ on: false, channel: 0, pitch: 60, velocity: 0 })
    expect(parseNote([0xb0, 64, 127])).toBeNull()
  })
})
