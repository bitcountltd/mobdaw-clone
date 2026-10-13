import { describe, expect, it } from 'vitest'
import { fmtPan, peakText } from '../src/studio/mixer/mixer'

describe('mixer readouts', () => {
  it('writes pan as L / C / R', () => {
    expect(fmtPan(0)).toBe('C')
    expect(fmtPan(0.004)).toBe('C')
    expect(fmtPan(-0.25)).toBe('L25')
    expect(fmtPan(1)).toBe('R100')
  })
  it('writes peaks in dBFS', () => {
    expect(peakText(0)).toBe('-∞')
    expect(peakText(1)).toBe('0.0')
    expect(peakText(0.5)).toBe('-6.0')
    expect(peakText(2)).toBe('+6.0')
  })
})
