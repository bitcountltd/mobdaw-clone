import { describe, expect, it } from 'vitest'
import { edited } from '../src/pages/edited'
import { formatValue, meterPos } from '../src/theme/controls'
import { ICON_NAMES, iconHtml } from '../src/theme/icons'

describe('formatValue', () => {
  it('formats units', () => {
    expect(formatValue(440, 'hz')).toBe('440 Hz')
    expect(formatValue(1200, 'hz')).toBe('1.20 kHz')
    expect(formatValue(12000, 'hz')).toBe('12.0 kHz')
    expect(formatValue(85, 'ms')).toBe('85 ms')
    expect(formatValue(1400, 'ms')).toBe('1.40 s')
    expect(formatValue(0.3)).toBe('0.30')
  })
})

describe('meterPos', () => {
  it('maps the dB range onto 0..1, monotonic and clamped', () => {
    expect(meterPos(-120)).toBe(0)
    expect(meterPos(6)).toBe(1)
    expect(meterPos(20)).toBe(1)
    expect(meterPos(-12)).toBeLessThan(meterPos(-3))
  })
})

describe('edited', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime()
  it('reads like a person would say it', () => {
    expect(edited(now - 5_000, now)).toBe('edited just now')
    expect(edited(now - 5 * 60_000, now)).toBe('edited 5 min ago')
    expect(edited(new Date(2026, 9, 11, 9).getTime(), now)).toBe('edited yesterday')
    expect(edited(new Date(2026, 9, 8, 9).getTime(), now)).toBe('edited 4 days ago')
    expect(edited(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/)
  })
})

describe('icons', () => {
  it('are all 16px stroke icons', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(45)
    for (const n of ICON_NAMES) expect(iconHtml(n)).toMatch(/^<svg [^>]*viewBox="0 0 16 16"[^>]*stroke-width="1.6"/)
  })
})
