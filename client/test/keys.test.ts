import { describe, expect, it } from 'vitest'
import { chords, matches, pick, shortcutText, type KeyLike } from '../src/studio/keys'

const ev = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({
  key, code: o.code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key === ' ' ? 'Space' : ''),
  shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o,
})

describe('matches', () => {
  it('matches plain letters case-insensitively, shift strictly', () => {
    expect(matches({ key: 'b' }, ev('b'))).toBe(true)
    expect(matches({ key: 'b' }, ev('B', { shiftKey: true }))).toBe(false)
    expect(matches({ key: 'k', mods: { shift: true } }, ev('K', { shiftKey: true }))).toBe(true)
  })
  it('names space and other keys', () => {
    expect(matches({ key: 'space' }, ev(' '))).toBe(true)
    expect(matches({ key: 'escape' }, ev('Escape'))).toBe(true)
    expect(matches({ key: ['delete', 'backspace'] }, ev('Backspace'))).toBe(true)
  })
  it('mod is cmd on a mac and ctrl elsewhere', () => {
    const b = { key: 'z', mods: { mod: true } }
    expect(matches(b, ev('z', { metaKey: true }), true)).toBe(true)
    expect(matches(b, ev('z', { ctrlKey: true }), true)).toBe(false)
    expect(matches(b, ev('z', { ctrlKey: true }), false)).toBe(true)
    expect(matches(b, ev('z', { metaKey: true }), false)).toBe(false)
    expect(matches({ key: 'z' }, ev('z', { ctrlKey: true }), false)).toBe(false)
  })
  it('symbols ignore shift unless it is given', () => {
    expect(matches({ key: '?' }, ev('?', { shiftKey: true, code: 'Slash' }))).toBe(true)
    expect(matches({ key: '=' }, ev('=', { code: 'Equal' }))).toBe(true)
  })
  it('falls back to the physical key for letters (alt on a mac, other layouts)', () => {
    expect(matches({ key: 'l', mods: { alt: true } }, ev('¬', { altKey: true, code: 'KeyL' }))).toBe(true)
  })
  it('matches by code', () => {
    expect(matches({ code: ['KeyA', 'Semicolon'] }, ev('ö', { code: 'Semicolon' }))).toBe(true)
    expect(matches({ code: 'KeyA' }, ev('a', { shiftKey: true }))).toBe(false)
  })
})

describe('pick', () => {
  const run = () => {}
  const entries = [
    { seq: 0, key: 'd', run, label: 'dock', group: 'View', readOnly: true },
    { seq: 1, key: 's', run, label: 'split', group: 'Editing' },
    { seq: 2, code: 'KeyD', run, label: 'note', group: 'Keyboard instrument', priority: 10, when: () => on },
  ]
  let on = false
  it('honours when and priority', () => {
    expect(pick(entries, ev('d'))?.label).toBe('dock')
    on = true
    expect(pick(entries, ev('d'))?.label).toBe('note')
  })
  it('skips editing keys in read-only projects', () => {
    expect(pick(entries, ev('s'), false, true)).toBeNull()
    expect(pick(entries, ev('s'), false, false)?.label).toBe('split')
  })
  it('later registrations win at equal priority', () => {
    const e2 = [...entries, { seq: 3, key: 's', run, label: 'split 2', group: 'Editing' }]
    expect(pick(e2, ev('s'))?.label).toBe('split 2')
  })
})

describe('display', () => {
  it('writes chords', () => {
    expect(chords({ key: 'z', mods: { mod: true, shift: true } }, true)).toEqual([['⌘', '⇧', 'Z']])
    expect(shortcutText({ key: 'z', mods: { mod: true } }, false)).toBe('ctrl+Z')
    expect(chords({ key: ['delete', 'backspace'] })).toEqual([['delete'], ['⌫']])
    expect(chords({ code: 'KeyA', display: 'A – ;' })).toEqual([['A – ;']])
  })
})
