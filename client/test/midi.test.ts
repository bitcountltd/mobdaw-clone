import { describe, expect, it } from 'vitest'
import { actionFor, debouncer, describeTrigger, parseTrigger, sameTrigger } from '../src/midi'

describe('parseTrigger', () => {
  it('accepts note-on and controller changes with a value above 0', () => {
    expect(parseTrigger([0x90, 60, 100])).toEqual({ kind: 'note', channel: 0, number: 60 })
    expect(parseTrigger([0x93, 36, 1])).toEqual({ kind: 'note', channel: 3, number: 36 })
    expect(parseTrigger([0xb1, 64, 127])).toEqual({ kind: 'cc', channel: 1, number: 64 })
  })
  it('ignores note-off, note-on at velocity 0, controllers at 0, and other messages', () => {
    expect(parseTrigger([0x80, 60, 64])).toBeNull()
    expect(parseTrigger([0x90, 60, 0])).toBeNull()
    expect(parseTrigger([0xb0, 64, 0])).toBeNull()
    expect(parseTrigger([0xc0, 5])).toBeNull() // program change
    expect(parseTrigger([0xf8])).toBeNull() // clock
    expect(parseTrigger([])).toBeNull()
  })
})

describe('debouncer', () => {
  it('drops repeats of a switch within 50 ms, but not other switches or later presses', () => {
    const ok = debouncer()
    const a = { kind: 'note' as const, channel: 0, number: 60 }
    const b = { kind: 'cc' as const, channel: 0, number: 60 }
    expect(ok(a, 1000)).toBe(true)
    expect(ok(a, 1030)).toBe(false)
    expect(ok(b, 1031)).toBe(true)
    expect(ok(a, 1100)).toBe(true)
  })
})

describe('bindings', () => {
  it('finds the action of a trigger, and tells triggers apart by kind and channel', () => {
    const t = { kind: 'cc' as const, channel: 2, number: 7 }
    expect(actionFor({ stopAll: t }, { ...t })).toBe('stopAll')
    expect(actionFor({ stopAll: t }, { ...t, channel: 3 })).toBeNull()
    expect(sameTrigger(t, { ...t, kind: 'note' })).toBe(false)
    expect(describeTrigger({ kind: 'note', channel: 0, number: 60 })).toBe('note c4 · ch 1')
  })
})
