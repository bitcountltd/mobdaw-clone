import { describe, expect, it } from 'vitest'
import { groupKeys } from '../src/studio/help'

describe('help overlay', () => {
  it('groups in order and merges rows with the same label', () => {
    const run = () => {}
    const g = groupKeys([
      { key: 'b', label: 'browser', group: 'View', run },
      { key: 'space', label: 'play / stop', group: 'Transport', run },
      { key: 'c', mods: { mod: true }, label: 'copy', group: 'Clips', run },
      { key: 'delete', label: 'delete', group: 'Editing', run },
      { key: 'backspace', label: 'delete', group: 'Editing', run },
      { key: 'y', label: 'hidden', group: 'Editing', run, hidden: true },
    ])
    expect(g.map(([n]) => n)).toEqual(['Transport', 'Editing', 'View', 'Clips'])
    expect(g[1][1]).toEqual([{ label: 'delete', chords: [['delete'], ['⌫']] }])
  })
})
