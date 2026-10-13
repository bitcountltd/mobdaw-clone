import { describe, expect, it } from 'vitest'
import { groupKeys, keysTakenOver } from '../src/studio/help'

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
  it('lists the letter shortcuts the keyboard instrument replaces while it is on', () => {
    const run = () => {}, when = () => true
    const taken = keysTakenOver([
      { code: ['KeyA', 'KeyS', 'KeyD', 'KeyL'], when, label: 'play', group: 'Keyboard instrument', run },
      { code: ['KeyZ', 'KeyX'], when, label: 'octave', group: 'Keyboard instrument', run },
      { key: 'k', mods: { shift: true }, label: 'keys on / off', group: 'Keyboard instrument', run },
      { key: 'd', label: 'dock', group: 'View', run },
      { key: 'x', label: 'arrange / mix', group: 'View', run },
      { key: 's', mods: { shift: true }, label: 'solo', group: 'Editing', run },
      { key: 'z', mods: { mod: true }, label: 'undo', group: 'Editing', run },
      { key: 'b', label: 'browser', group: 'View', run },
    ])
    expect(taken).toEqual(['D', 'S', 'X'])
  })
})
