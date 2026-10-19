// Device catalogue shared by the UI. Ids and ranges must match docs/engine-api.md.
export type ParamDef = {
  id: number
  name: string
  min: number
  max: number
  def: number
  /** How a 0..1 slider maps to the value: linear, logarithmic (min > 0) or cubic (fine control near min). */
  scale: 'lin' | 'log' | 'pow'
  unit?: string
  /** Discrete choices (value = index); rendered as a select. */
  options?: string[]
}
export type DeviceDef = { type: number; name: string; instrument: boolean; params: ParamDef[] }

export const SIMPLE_FILTER = 1
export const FINNWAVE = 2
export const REVERB = 3
export const COMPRESSOR = 4
export const TREMOLO = 5
export const DELAY = 6
export const LOFI_DRUM = 7
export const EQ = 8
export const DRUM_SYNTH = 9

/** The drum synth's tone models (param 0), in order. */
export const DRUM_MODELS = ['analog', 'fm', 'modal', 'metal', 'string'] as const
/** What the drum synth's `character` (5) and `timbre` (6) knobs do in each model. */
export const DRUM_MACROS: [string, string][] = [['wave', 'overtone'], ['ratio', 'index'], ['material', 'strike'], ['spread', 'bright'], ['damping', 'snare']]

const EQ_BANDS = [
  { name: 'low', hz: 100 },
  { name: 'bell 1', hz: 500 },
  { name: 'bell 2', hz: 2000 },
  { name: 'high', hz: 8000 },
]
const eqParams = (): ParamDef[] => [
  ...EQ_BANDS.flatMap((b, i): ParamDef[] => [
    { id: i * 3, name: `${b.name} freq`, min: 20, max: 20000, def: b.hz, scale: 'log', unit: 'hz' },
    { id: i * 3 + 1, name: `${b.name} gain`, min: -24, max: 24, def: 0, scale: 'lin', unit: 'db' },
    { id: i * 3 + 2, name: `${b.name} damping`, min: 0.05, max: 2, def: 0.7071, scale: 'lin' },
  ]),
  { id: 12, name: 'output', min: -24, max: 24, def: 0, scale: 'lin', unit: 'db' },
]

export const DEVICES: Record<number, DeviceDef> = {
  [SIMPLE_FILTER]: {
    type: SIMPLE_FILTER, name: 'Filter', instrument: false,
    params: [
      { id: 0, name: 'mode', min: 0, max: 7, def: 0, scale: 'lin', options: ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'bell', 'low shelf', 'high shelf'] },
      { id: 1, name: 'cutoff', min: 20, max: 20000, def: 1000, scale: 'log', unit: 'hz' },
      { id: 2, name: 'damping', min: 0.05, max: 2, def: 0.7071, scale: 'lin' },
      { id: 3, name: 'gain', min: -24, max: 24, def: 0, scale: 'lin', unit: 'db' },
    ],
  },
  [EQ]: { type: EQ, name: 'EQ', instrument: false, params: eqParams() },
  [REVERB]: {
    type: REVERB, name: 'Reverb', instrument: false,
    params: [
      { id: 0, name: 'mix', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 1, name: 'size', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'damping', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 3, name: 'predelay', min: 0, max: 200, def: 0, scale: 'pow', unit: 'ms' },
    ],
  },
  [COMPRESSOR]: {
    type: COMPRESSOR, name: 'Compressor', instrument: false,
    params: [
      { id: 0, name: 'threshold', min: -60, max: 0, def: -18, scale: 'lin', unit: 'db' },
      { id: 1, name: 'ratio', min: 1, max: 20, def: 4, scale: 'log', unit: ':1' },
      { id: 2, name: 'attack', min: 0.1, max: 100, def: 10, scale: 'log', unit: 'ms' },
      { id: 3, name: 'release', min: 10, max: 1000, def: 100, scale: 'log', unit: 'ms' },
      { id: 4, name: 'makeup', min: 0, max: 24, def: 0, scale: 'lin', unit: 'db' },
    ],
  },
  [TREMOLO]: {
    type: TREMOLO, name: 'Tremolo', instrument: false,
    params: [
      { id: 0, name: 'rate', min: 0.1, max: 20, def: 4, scale: 'log', unit: 'hz' },
      { id: 1, name: 'depth', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'shape', min: 0, max: 2, def: 0, scale: 'lin', options: ['sine', 'triangle', 'square'] },
      { id: 3, name: 'spread', min: 0, max: 1, def: 0, scale: 'lin' },
    ],
  },
  [DELAY]: {
    type: DELAY, name: 'Tape delay', instrument: false,
    params: [
      { id: 0, name: 'mix', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 1, name: 'time', min: 10, max: 2000, def: 375, scale: 'log', unit: 'ms' },
      { id: 2, name: 'feedback', min: 0, max: 1.2, def: 0.4, scale: 'lin' },
      { id: 3, name: 'warble', min: 0, max: 1, def: 0.25, scale: 'lin' },
      { id: 4, name: 'drive', min: 0, max: 1, def: 0, scale: 'lin' },
      { id: 5, name: 'filter', min: 0, max: 2, def: 0, scale: 'lin', options: ['lowpass', 'highpass', 'bandpass'] },
      { id: 6, name: 'cutoff', min: 100, max: 20000, def: 4000, scale: 'log', unit: 'hz' },
      { id: 7, name: 'resonance', min: 0, max: 1, def: 0, scale: 'lin' },
    ],
  },
  [LOFI_DRUM]: {
    type: LOFI_DRUM, name: 'Lofi drum', instrument: true,
    params: [
      { id: 0, name: 'cutoff', min: 20, max: 20000, def: 2000, scale: 'log', unit: 'hz' },
      { id: 1, name: 'resonance', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 2, name: 'decay', min: 1, max: 2000, def: 60, scale: 'pow', unit: 'ms' },
      { id: 3, name: 'gain', min: 0, max: 2, def: 0.5, scale: 'lin' },
    ],
  },
  [DRUM_SYNTH]: {
    type: DRUM_SYNTH, name: 'Drum synth', instrument: true,
    params: [
      // body: the pitched tone, in one of five models
      { id: 0, name: 'model', min: 0, max: 4, def: 0, scale: 'lin', options: [...DRUM_MODELS] },
      { id: 1, name: 'pitch', min: 20, max: 8000, def: 55, scale: 'log', unit: 'hz' },
      { id: 2, name: 'bend', min: -24, max: 48, def: 12, scale: 'lin', unit: 'st' },
      { id: 3, name: 'bend time', min: 1, max: 1000, def: 45, scale: 'log', unit: 'ms' },
      { id: 4, name: 'decay', min: 5, max: 5000, def: 350, scale: 'log', unit: 'ms' },
      { id: 5, name: 'character', min: 0, max: 1, def: 0.2, scale: 'lin' },
      { id: 6, name: 'timbre', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 7, name: 'body', min: 0, max: 1.5, def: 1, scale: 'lin' },
      // noise: filtered white noise under its own envelope
      { id: 8, name: 'noise', min: 0, max: 1.5, def: 0, scale: 'lin' },
      { id: 9, name: 'noise filter', min: 0, max: 2, def: 1, scale: 'lin', options: ['lowpass', 'bandpass', 'highpass'] },
      { id: 10, name: 'noise freq', min: 40, max: 18000, def: 5000, scale: 'log', unit: 'hz' },
      { id: 11, name: 'noise res', min: 0, max: 1, def: 0.2, scale: 'lin' },
      { id: 12, name: 'noise decay', min: 2, max: 3000, def: 150, scale: 'log', unit: 'ms' },
      { id: 13, name: 'noise shape', min: 0, max: 3, def: 0, scale: 'lin', options: ['decay', 'gate', 'clap', 'swell'] },
      { id: 14, name: 'sweep', min: -1, max: 1, def: 0, scale: 'lin' },
      // click: the transient
      { id: 15, name: 'click', min: 0, max: 1.5, def: 0.3, scale: 'lin' },
      { id: 16, name: 'click tone', min: 0, max: 1, def: 0.5, scale: 'lin' },
      // out
      { id: 17, name: 'drive', min: 0, max: 1, def: 0, scale: 'lin' },
      { id: 18, name: 'color', min: -1, max: 1, def: 0, scale: 'lin' },
      { id: 19, name: 'velocity', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 20, name: 'pan', min: -1, max: 1, def: 0, scale: 'lin' },
      { id: 21, name: 'choke', min: 0, max: 4, def: 0, scale: 'lin', options: ['off', 'A', 'B', 'C', 'D'] },
      { id: 22, name: 'level', min: 0, max: 2, def: 0.8, scale: 'lin' },
    ],
  },
  [FINNWAVE]: {
    type: FINNWAVE, name: 'Finnwave', instrument: true,
    params: [
      { id: 0, name: 'rolloff', min: 0.001, max: 3, def: 0.3, scale: 'log' },
      { id: 1, name: 'env→rolloff', min: 0, max: 3, def: 0.5, scale: 'lin' },
      { id: 2, name: 'attack', min: 0, max: 5000, def: 5, scale: 'pow', unit: 'ms' },
      { id: 3, name: 'decay', min: 0, max: 5000, def: 300, scale: 'pow', unit: 'ms' },
      { id: 4, name: 'sustain', min: 0, max: 1, def: 0.6, scale: 'lin' },
      { id: 5, name: 'release', min: 0, max: 10000, def: 200, scale: 'pow', unit: 'ms' },
      { id: 6, name: 'gain', min: 0, max: 2, def: 0.5, scale: 'lin' },
    ],
  },
}

/** Effects offered by the fx bar's "+". */
export const EFFECTS = Object.values(DEVICES).filter((d) => !d.instrument)
/** Instruments offered by the synths lane's "+". */
export const INSTRUMENTS = Object.values(DEVICES).filter((d) => d.instrument)

export function paramToValue(p: ParamDef, t: number): number {
  if (p.options) return Math.round(p.min + t * (p.max - p.min))
  if (p.scale === 'log') return p.min * (p.max / p.min) ** t
  if (p.scale === 'pow') return p.min + (p.max - p.min) * t ** 3
  return p.min + t * (p.max - p.min)
}
export function paramToPos(p: ParamDef, v: number): number {
  const c = Math.min(p.max, Math.max(p.min, v))
  if (p.scale === 'log') return Math.log(c / p.min) / Math.log(p.max / p.min)
  if (p.scale === 'pow') return Math.cbrt((c - p.min) / (p.max - p.min))
  return (c - p.min) / (p.max - p.min)
}
