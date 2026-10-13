import { describe, expect, it } from 'vitest'
import { dockMax } from '../src/studio/dock/dock'

describe('dock height', () => {
  it('leaves the arrangement 260px of the window, and never goes under the minimum', () => {
    expect(dockMax(900)).toBe(640)
    expect(dockMax(720)).toBe(460)
    expect(dockMax(300)).toBe(140)
  })
})
