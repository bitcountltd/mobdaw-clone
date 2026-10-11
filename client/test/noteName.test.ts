import { describe, expect, it } from 'vitest'
import { noteName, parseNote } from '../src/ui/noteName'

describe('note names', () => {
  it('name pitches the way the piano roll does: 60 is c4', () => {
    expect([0, 36, 37, 60, 61, 127].map(noteName)).toEqual(['c-1', 'c2', 'c#2', 'c4', 'c#4', 'g9'])
  })
  it('parse names (any case, sharps and flats) and plain numbers, and refuse the rest', () => {
    expect(['c2', 'C#2', 'Db2', 'c4', 'g9', 'c-1', '36', ' f#3 '].map(parseNote)).toEqual([36, 37, 37, 60, 127, 0, 36, 54])
    expect(['', 'h2', 'c', 'g#9', '128', 'c-2', '1.5'].map(parseNote)).toEqual([null, null, null, null, null, null, null])
    for (let p = 0; p < 128; p++) expect(parseNote(noteName(p))).toBe(p)
  })
})
