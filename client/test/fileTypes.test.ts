import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppleTouch, isAudioFile } from '../src/fileTypes'

describe('file types', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('takes audio by type or by extension (iOS often gives no type), and leaves MIDI to the MIDI import', () => {
    expect(isAudioFile({ name: 'take.wav', type: '' })).toBe(true)
    expect(isAudioFile({ name: 'Voice Memo.m4a', type: '' })).toBe(true)
    expect(isAudioFile({ name: 'loop.AIFF', type: '' })).toBe(true)
    expect(isAudioFile({ name: 'x', type: 'audio/mpeg' })).toBe(true)
    expect(isAudioFile({ name: 'song.mid', type: 'audio/midi' })).toBe(false)
    expect(isAudioFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
  })

  it('knows iPhones, iPads and iPads asking for the desktop site', () => {
    const as = (userAgent: string, platform: string, maxTouchPoints: number) => vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints })
    as('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad', 5)
    expect(isAppleTouch()).toBe(true)
    as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 'MacIntel', 5) // iPadOS default: a desktop UA
    expect(isAppleTouch()).toBe(true)
    as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 'MacIntel', 0)
    expect(isAppleTouch()).toBe(false)
  })
})
