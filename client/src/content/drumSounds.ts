// The drum synth's sound library: single drums by category, which the drum editor's preset menu, the browser and the
// kits (content/presets.ts) draw on. Every sound sets all 23 params (shared/src/devices.ts, DRUM_SYNTH): the table
// below names only what differs from `BASE`, a neutral starting point (a plain body, no noise, no click, no bend).
//
// How the sounds were built (engine/crates/dsp/src/drumsynth.rs has the models):
// - Electronic kits follow their circuits: the 808 kick is a barely-bent sine ringing long; the 909's is a shaped
//   triangle with a big fast sweep and a click; 808 / 909 snares are one or two tones plus high-passed noise; claps
//   are the burst envelope through a ~1 kHz band-pass; hats and cymbals are the six 808 squares (205-800 Hz) through a
//   band-pass high above them, with a little noise; the 808 cowbell is the cluster's first two squares (540 / 800 Hz).
// - Acoustic drums are modal: a membrane's Bessel modes for snares, toms and congas (a little upward pitch at the
//   strike, as a skin's tension does), harmonic modes for tabla and steel pans, a free bar's for woodblocks, claves and
//   marimba, bell partials for agogo, cowbell and triangle. A beater or stick is the click; snare wires are noise.
// - Levels are matched by ear-ish numbers: every sound was rendered (engine/crates/dsp/tests/drum_presets.rs) and its
//   loudest 50 ms set near its category's target, kicks loudest and hats well below.
import { DRUM_SYNTH, DEVICES } from '@mobdaw/shared'

export type DrumCategory = 'kick' | 'snare' | 'clap' | 'hat' | 'cymbal' | 'tom' | 'perc' | 'world' | 'tuned' | 'fx'
export const DRUM_CATEGORIES: [DrumCategory, string][] = [
  ['kick', 'Kicks'], ['snare', 'Snares & rims'], ['clap', 'Claps & snaps'], ['hat', 'Hats'], ['cymbal', 'Cymbals'],
  ['tom', 'Toms'], ['perc', 'Percussion'], ['world', 'World'], ['tuned', 'Tuned'], ['fx', 'FX'],
]
export type DrumSound = { id: string; name: string; category: DrumCategory; params: Record<string, number> }

/** Every param at its default: what a fresh drum synth starts from. */
export const drumDefaults = (): Record<string, number> =>
  Object.fromEntries(DEVICES[DRUM_SYNTH].params.map((p) => [String(p.id), p.def]))

/** The params by name, so the table reads. */
const ID = {
  model: 0, pitch: 1, bend: 2, bendTime: 3, decay: 4, char: 5, timbre: 6, body: 7,
  noise: 8, nf: 9, nfreq: 10, nres: 11, ndecay: 12, nshape: 13, sweep: 14,
  click: 15, ctone: 16, drive: 17, color: 18, vel: 19, pan: 20, choke: 21, level: 22,
} as const
type P = Partial<Record<keyof typeof ID, number>>
// models, noise filters, noise shapes
const AN = 0, FM = 1, MO = 2, ME = 3, ST = 4
const LP = 0, BP = 1, HP = 2
const DEC = 0, GATE = 1, CLAP = 2, SWELL = 3
// modal materials (character)
const MEMBRANE = 0, TUNED_SKIN = 0.2, HARMONIC = 1 / 3, BAR = 2 / 3, BELL = 1
// choke groups
const HATS = 1, MUTES = 2

const BASE: Required<P> = {
  model: AN, pitch: 200, bend: 0, bendTime: 40, decay: 300, char: 0, timbre: 0, body: 1,
  noise: 0, nf: BP, nfreq: 5000, nres: 0.1, ndecay: 150, nshape: DEC, sweep: 0,
  click: 0, ctone: 0.5, drive: 0, color: 0, vel: 0.5, pan: 0, choke: 0, level: 0.8,
}
const s = (id: string, name: string, category: DrumCategory, p: P): DrumSound => {
  const all = { ...BASE, ...p }
  return { id, name, category, params: Object.fromEntries(Object.entries(all).map(([k, v]) => [String(ID[k as keyof typeof ID]), v])) }
}

export const DRUM_SOUNDS: DrumSound[] = [
  // ---- kicks
  s('kick-808', '808 kick', 'kick', { pitch: 49, bend: 7, bendTime: 30, decay: 1100, click: 0.15, ctone: 0.35, level: 0.58 }),
  s('kick-808-long', '808 boom', 'kick', { pitch: 44, bend: 9, bendTime: 45, decay: 2600, click: 0.12, ctone: 0.3, drive: 0.2, level: 0.47 }),
  s('kick-trap', 'Trap 808', 'kick', { pitch: 42, bend: 12, bendTime: 70, decay: 2200, char: 0.15, click: 0.3, ctone: 0.55, drive: 0.4, level: 0.42 }),
  s('kick-909', '909 kick', 'kick', { pitch: 52, bend: 32, bendTime: 28, decay: 520, char: 0.38, click: 0.6, ctone: 0.75, noise: 0.25, nf: BP, nfreq: 3200, nres: 0.2, ndecay: 12, drive: 0.25, level: 0.6 }),
  s('kick-909-long', '909 long kick', 'kick', { pitch: 50, bend: 30, bendTime: 30, decay: 1200, char: 0.4, click: 0.55, ctone: 0.7, noise: 0.2, nf: BP, nfreq: 3000, nres: 0.2, ndecay: 12, drive: 0.35, level: 0.47 }),
  s('kick-606', '606 kick', 'kick', { pitch: 62, bend: 10, bendTime: 15, decay: 260, click: 0.25, ctone: 0.5, level: 0.74 }),
  s('kick-cr78', 'Rhythm box kick', 'kick', { pitch: 68, bend: 4, bendTime: 20, decay: 220, click: 0.08, ctone: 0.2, color: -0.3, level: 0.7 }),
  s('kick-linn', 'Linn kick', 'kick', { pitch: 57, bend: 14, bendTime: 22, decay: 340, char: 0.2, click: 0.85, ctone: 0.55, noise: 0.2, nf: LP, nfreq: 1500, ndecay: 25, drive: 0.15, level: 0.67 }),
  s('kick-acoustic', 'Studio kick', 'kick', { model: MO, char: MEMBRANE, timbre: 0.15, pitch: 56, bend: 4, bendTime: 25, decay: 420, click: 0.9, ctone: 0.45, noise: 0.35, nf: LP, nfreq: 600, ndecay: 70, drive: 0.15, level: 0.6 }),
  s('kick-jazz', 'Jazz kick', 'kick', { model: MO, char: MEMBRANE, timbre: 0.3, pitch: 72, bend: 2, bendTime: 30, decay: 750, click: 0.55, ctone: 0.3, noise: 0.2, nf: LP, nfreq: 400, ndecay: 90, level: 0.54 }),
  s('kick-rock', 'Rock kick', 'kick', { model: MO, char: MEMBRANE, timbre: 0.2, pitch: 60, bend: 6, bendTime: 18, decay: 380, click: 1.2, ctone: 0.62, noise: 0.3, nf: LP, nfreq: 900, ndecay: 40, drive: 0.35, color: 0.2, level: 0.57 }),
  s('kick-house', 'House kick', 'kick', { pitch: 51, bend: 18, bendTime: 32, decay: 480, char: 0.12, click: 0.35, ctone: 0.4, drive: 0.15, level: 0.6 }),
  s('kick-techno', 'Techno rumble', 'kick', { pitch: 48, bend: 22, bendTime: 26, decay: 820, char: 0.3, click: 0.5, ctone: 0.6, drive: 0.6, color: -0.35, level: 0.35 }),
  s('kick-hard', 'Hard kick', 'kick', { pitch: 55, bend: 34, bendTime: 45, decay: 620, char: 0.62, click: 0.7, ctone: 0.8, drive: 1, color: 0.1, level: 0.38 }),
  s('kick-punch', 'Punch kick', 'kick', { pitch: 60, bend: 24, bendTime: 16, decay: 300, char: 0.1, click: 0.75, ctone: 0.65, drive: 0.3, level: 0.58 }),
  s('kick-sub', 'Sub kick', 'kick', { pitch: 40, bend: 5, bendTime: 40, decay: 900, level: 0.6 }),
  s('kick-lofi', 'Dusty thump', 'kick', { pitch: 56, bend: 9, bendTime: 30, decay: 260, char: 0.25, click: 0.4, ctone: 0.25, drive: 0.25, color: -0.7, level: 0.54 }),
  s('kick-fm', 'FM kick', 'kick', { model: FM, char: 0.25, timbre: 0.55, pitch: 50, bend: 26, bendTime: 25, decay: 450, click: 0.3, ctone: 0.6, level: 0.62 }),
  s('kick-simmons', 'Electro kick', 'kick', { pitch: 62, bend: 20, bendTime: 120, decay: 420, char: 0.45, noise: 0.25, nf: LP, nfreq: 1800, ndecay: 60, click: 0.3, level: 0.68 }),
  s('kick-tight', 'Tight kick', 'kick', { pitch: 70, bend: 20, bendTime: 10, decay: 140, click: 0.6, ctone: 0.7, drive: 0.2, level: 0.71 }),

  // ---- snares and rims
  s('snare-808', '808 snare', 'snare', { pitch: 238, bend: 3, bendTime: 15, decay: 160, timbre: 0.5, body: 0.85, noise: 0.85, nf: HP, nfreq: 1800, ndecay: 190, click: 0.25, ctone: 0.6, level: 0.46 }),
  s('snare-808-snappy', '808 snappy', 'snare', { pitch: 230, bend: 3, bendTime: 15, decay: 120, timbre: 0.5, body: 0.6, noise: 1.2, nf: HP, nfreq: 2200, ndecay: 260, click: 0.3, ctone: 0.7, level: 0.45 }),
  s('snare-909', '909 snare', 'snare', { pitch: 185, bend: 6, bendTime: 18, decay: 130, char: 0.4, timbre: 0.3, body: 0.8, noise: 1, nf: LP, nfreq: 7000, nres: 0.35, ndecay: 210, sweep: 0.15, click: 0.45, ctone: 0.75, drive: 0.15, level: 0.56 }),
  s('snare-606', '606 snare', 'snare', { pitch: 260, bend: 4, bendTime: 10, decay: 90, timbre: 0.4, body: 0.5, noise: 1.1, nf: BP, nfreq: 5200, nres: 0.1, ndecay: 130, click: 0.3, ctone: 0.8, level: 0.73 }),
  s('snare-cr78', 'Rhythm box snare', 'snare', { pitch: 300, bend: 2, bendTime: 10, decay: 70, body: 0.45, noise: 0.9, nf: LP, nfreq: 5500, ndecay: 110, click: 0.1, color: -0.25, level: 1.07 }),
  s('snare-linn', 'Linn snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.5, pitch: 210, bend: 3, bendTime: 20, decay: 180, body: 0.9, noise: 1, nf: LP, nfreq: 8000, nres: 0.15, ndecay: 230, click: 0.7, ctone: 0.7, drive: 0.25, level: 0.58 }),
  s('snare-acoustic', 'Studio snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.55, pitch: 192, bend: 2, bendTime: 25, decay: 240, body: 0.8, noise: 0.9, nf: BP, nfreq: 4500, nres: 0.05, ndecay: 260, click: 0.6, ctone: 0.72, vel: 0.65, level: 0.56 }),
  s('snare-rock', 'Fat rock snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.45, pitch: 168, bend: 3, bendTime: 25, decay: 320, body: 0.95, noise: 1.05, nf: BP, nfreq: 3600, nres: 0, ndecay: 360, click: 0.75, ctone: 0.65, drive: 0.3, level: 0.44 }),
  s('snare-gated', 'Gated 80s snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.5, pitch: 180, bend: 3, bendTime: 25, decay: 260, body: 0.8, noise: 1.1, nf: BP, nfreq: 3000, nres: 0, ndecay: 240, nshape: GATE, click: 0.7, ctone: 0.7, drive: 0.25, level: 0.41 }),
  s('snare-piccolo', 'Piccolo snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.65, pitch: 330, bend: 2, bendTime: 15, decay: 170, body: 0.7, noise: 0.85, nf: BP, nfreq: 6500, nres: 0.05, ndecay: 170, click: 0.7, ctone: 0.85, level: 0.6 }),
  s('snare-brush', 'Brush snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.3, pitch: 200, bend: 1, decay: 150, body: 0.25, noise: 1, nf: LP, nfreq: 6500, nres: 0.05, ndecay: 320, click: 0.1, ctone: 0.4, vel: 0.7, level: 1.05 }),
  s('snare-brush-swish', 'Brush swish', 'snare', { body: 0, noise: 0.9, nf: BP, nfreq: 5000, nres: 0, ndecay: 260, nshape: SWELL, sweep: -0.2, level: 0.95 }),
  s('snare-trap', 'Trap snare', 'snare', { pitch: 205, bend: 5, bendTime: 15, decay: 140, timbre: 0.45, body: 0.7, noise: 1.1, nf: BP, nfreq: 2400, nres: 0.1, ndecay: 200, click: 0.4, ctone: 0.7, drive: 0.35, level: 0.54 }),
  s('snare-lofi', 'Dusty snare', 'snare', { model: MO, char: MEMBRANE, timbre: 0.45, pitch: 185, bend: 2, decay: 200, body: 0.8, noise: 0.95, nf: LP, nfreq: 4200, nres: 0.15, ndecay: 220, click: 0.4, ctone: 0.5, drive: 0.3, color: -0.6, level: 0.58 }),
  s('snare-fm', 'FM snare', 'snare', { model: FM, char: 0.39, timbre: 0.7, pitch: 180, bend: 7, bendTime: 15, decay: 140, body: 0.7, noise: 0.9, nf: HP, nfreq: 2500, ndecay: 180, click: 0.3, level: 0.53 }),
  s('snare-karplus', 'Karplus snare', 'snare', { model: ST, char: 0.85, timbre: 1, pitch: 170, decay: 260, body: 1, noise: 0.35, nf: HP, nfreq: 3500, ndecay: 120, click: 0.3, ctone: 0.7, level: 0.73 }),
  s('snare-electro', 'Electro snare', 'snare', { pitch: 260, bend: 12, bendTime: 60, decay: 200, char: 0.5, body: 0.7, noise: 0.9, nf: BP, nfreq: 2000, nres: 0.3, ndecay: 260, sweep: 0.4, click: 0.2, level: 0.99 }),
  s('rim-808', '808 rimshot', 'snare', { model: MO, char: BAR, timbre: 0.85, pitch: 455, decay: 35, click: 0.8, ctone: 0.85, drive: 0.5, level: 0.92 }),
  s('rim-acoustic', 'Rimshot', 'snare', { model: MO, char: 0.55, timbre: 0.8, pitch: 420, bend: 1, decay: 70, body: 0.8, noise: 0.6, nf: BP, nfreq: 4000, nres: 0.1, ndecay: 90, click: 1, ctone: 0.85, drive: 0.35, level: 0.92 }),
  s('sidestick', 'Sidestick', 'snare', { model: MO, char: 0.62, timbre: 0.6, pitch: 760, decay: 55, body: 0.9, click: 0.7, ctone: 0.75, noise: 0.2, nf: BP, nfreq: 3000, ndecay: 20, level: 0.88 }),

  // ---- claps and snaps
  s('clap-808', '808 clap', 'clap', { body: 0, noise: 1.2, nf: BP, nfreq: 1100, nres: 0.3, ndecay: 200, nshape: CLAP, level: 2.0 }),
  s('clap-909', '909 clap', 'clap', { body: 0, noise: 1.2, nf: BP, nfreq: 1350, nres: 0.2, ndecay: 260, nshape: CLAP, drive: 0.15, color: 0.2, level: 1.2 }),
  s('clap-big', 'Big clap', 'clap', { body: 0, noise: 1.25, nf: BP, nfreq: 1000, nres: 0.15, ndecay: 450, nshape: CLAP, drive: 0.3, level: 0.83 }),
  s('clap-tight', 'Tight clap', 'clap', { body: 0, noise: 1.2, nf: BP, nfreq: 1500, nres: 0.2, ndecay: 80, nshape: CLAP, level: 1.91 }),
  s('clap-lofi', 'Dusty clap', 'clap', { body: 0, noise: 1.2, nf: LP, nfreq: 2800, nres: 0.3, ndecay: 180, nshape: CLAP, drive: 0.2, color: -0.5, level: 0.92 }),
  s('clap-room', 'Room clap', 'clap', { body: 0, noise: 1.2, nf: BP, nfreq: 1200, nres: 0.1, ndecay: 700, nshape: CLAP, color: -0.15, level: 1.16 }),
  s('clap-reverse', 'Reverse clap', 'clap', { body: 0, noise: 1.2, nf: BP, nfreq: 1300, nres: 0.2, ndecay: 350, nshape: SWELL, level: 1.82 }),
  s('snap', 'Finger snap', 'clap', { model: MO, char: BAR, timbre: 0.7, pitch: 1800, decay: 25, body: 0.5, noise: 1, nf: BP, nfreq: 2600, nres: 0.3, ndecay: 55, click: 0.6, ctone: 0.85, level: 1.51 }),
  s('clap-hand', 'Hand clap', 'clap', { body: 0, noise: 1.2, nf: BP, nfreq: 1600, nres: 0.15, ndecay: 110, click: 0.5, ctone: 0.7, vel: 0.7, level: 1.65 }),

  // ---- hats (closed / pedal / open of a kit share choke group A)
  s('hat-808-closed', '808 closed hat', 'hat', { model: ME, pitch: 205, char: 0.6, timbre: 0.78, decay: 55, noise: 0.25, nf: HP, nfreq: 8000, ndecay: 40, choke: HATS, level: 1.38 }),
  s('hat-808-open', '808 open hat', 'hat', { model: ME, pitch: 205, char: 0.6, timbre: 0.78, decay: 420, noise: 0.25, nf: HP, nfreq: 8000, ndecay: 300, choke: HATS, level: 0.54 }),
  s('hat-909-closed', '909 closed hat', 'hat', { model: ME, pitch: 300, char: 0.75, timbre: 0.72, decay: 60, noise: 0.45, nf: HP, nfreq: 9000, ndecay: 50, drive: 0.25, choke: HATS, level: 0.58 }),
  s('hat-909-open', '909 open hat', 'hat', { model: ME, pitch: 300, char: 0.75, timbre: 0.72, decay: 550, noise: 0.45, nf: HP, nfreq: 9000, ndecay: 450, drive: 0.25, choke: HATS, level: 0.23 }),
  s('hat-606-closed', '606 closed hat', 'hat', { model: ME, pitch: 240, char: 0.55, timbre: 0.85, decay: 35, noise: 0.35, nf: HP, nfreq: 10000, ndecay: 30, choke: HATS, level: 1.66 }),
  s('hat-606-open', '606 open hat', 'hat', { model: ME, pitch: 240, char: 0.55, timbre: 0.85, decay: 280, noise: 0.35, nf: HP, nfreq: 10000, ndecay: 220, choke: HATS, level: 0.62 }),
  s('hat-closed', 'Closed hat', 'hat', { model: ME, pitch: 410, char: 0.9, timbre: 0.68, decay: 80, noise: 0.55, nf: HP, nfreq: 6500, ndecay: 70, click: 0.35, ctone: 1, vel: 0.65, choke: HATS, level: 0.65 }),
  s('hat-pedal', 'Pedal hat', 'hat', { model: ME, pitch: 410, char: 0.9, timbre: 0.6, decay: 110, noise: 0.4, nf: BP, nfreq: 6000, ndecay: 90, click: 0.45, ctone: 0.6, choke: HATS, level: 0.65 }),
  s('hat-open', 'Open hat', 'hat', { model: ME, pitch: 410, char: 0.9, timbre: 0.68, decay: 900, noise: 0.5, nf: HP, nfreq: 6500, ndecay: 650, click: 0.3, ctone: 1, vel: 0.65, choke: HATS, level: 0.28 }),
  s('hat-half', 'Half-open hat', 'hat', { model: ME, pitch: 410, char: 0.9, timbre: 0.68, decay: 260, noise: 0.55, nf: HP, nfreq: 6500, ndecay: 220, click: 0.3, ctone: 1, choke: HATS, level: 0.38 }),
  s('hat-trap', 'Trap hat', 'hat', { model: ME, pitch: 330, char: 0.7, timbre: 0.85, decay: 32, noise: 0.5, nf: HP, nfreq: 11000, ndecay: 28, color: 0.3, choke: HATS, level: 1.16 }),
  s('hat-noise', 'Noise hat', 'hat', { body: 0, noise: 0.8, nf: HP, nfreq: 9000, nres: 0.2, ndecay: 45, choke: HATS, level: 0.62 }),
  s('hat-noise-open', 'Noise open hat', 'hat', { body: 0, noise: 0.7, nf: HP, nfreq: 8500, nres: 0.2, ndecay: 400, choke: HATS, level: 0.26 }),
  s('hat-lofi', 'Dusty hat', 'hat', { model: ME, pitch: 260, char: 0.65, timbre: 0.6, decay: 60, noise: 0.5, nf: BP, nfreq: 6000, nres: 0.15, ndecay: 50, color: -0.4, choke: HATS, level: 1.02 }),
  s('hat-fm', 'FM hat', 'hat', { model: FM, char: 0.81, timbre: 1, pitch: 3100, decay: 45, noise: 0.45, nf: HP, nfreq: 9000, ndecay: 35, choke: HATS, level: 0.39 }),

  // ---- cymbals
  s('cym-808', '808 cymbal', 'cymbal', { model: ME, pitch: 205, char: 0.6, timbre: 0.6, decay: 1800, noise: 0.3, nf: HP, nfreq: 6000, ndecay: 1200, level: 0.31 }),
  s('crash', 'Crash', 'cymbal', { model: ME, pitch: 330, char: 0.88, timbre: 0.58, decay: 2400, noise: 0.55, nf: HP, nfreq: 4500, ndecay: 1800, click: 0.3, ctone: 0.8, level: 0.22 }),
  s('crash-dark', 'Dark crash', 'cymbal', { model: ME, pitch: 280, char: 0.92, timbre: 0.45, decay: 3000, noise: 0.5, nf: BP, nfreq: 4000, nres: 0, ndecay: 2400, click: 0.3, ctone: 0.6, color: -0.35, level: 0.25 }),
  s('splash', 'Splash', 'cymbal', { model: ME, pitch: 480, char: 0.9, timbre: 0.62, decay: 900, noise: 0.5, nf: HP, nfreq: 6000, ndecay: 700, click: 0.3, ctone: 0.9, level: 0.29 }),
  s('china', 'China', 'cymbal', { model: ME, pitch: 360, char: 1, timbre: 0.5, decay: 1600, noise: 0.5, nf: BP, nfreq: 3500, nres: 0.2, ndecay: 1200, drive: 0.55, click: 0.3, level: 0.12 }),
  s('ride', 'Ride', 'cymbal', { model: ME, pitch: 520, char: 0.78, timbre: 0.55, decay: 2800, noise: 0.18, nf: HP, nfreq: 7000, ndecay: 900, click: 0.55, ctone: 0.9, level: 0.33 }),
  s('ride-bell', 'Ride bell', 'cymbal', { model: MO, char: BELL, timbre: 0.6, pitch: 720, decay: 2200, body: 1, noise: 0.15, nf: HP, nfreq: 7000, ndecay: 300, click: 0.5, ctone: 0.9, level: 0.2 }),
  s('ride-fm', 'FM ride', 'cymbal', { model: FM, char: 0.93, timbre: 0.62, pitch: 610, decay: 2500, noise: 0.15, nf: HP, nfreq: 8000, ndecay: 600, click: 0.4, ctone: 0.9, level: 0.12 }),
  s('cym-reverse', 'Reverse cymbal', 'cymbal', { body: 0, noise: 0.9, nf: HP, nfreq: 5000, nres: 0.1, ndecay: 1600, nshape: SWELL, level: 0.18 }),
  s('sizzle', 'Sizzle', 'cymbal', { model: ME, pitch: 600, char: 0.95, timbre: 0.8, decay: 3500, noise: 0.6, nf: HP, nfreq: 9000, ndecay: 3000, level: 0.28 }),

  // ---- toms
  s('tom-808-low', '808 low tom', 'tom', { pitch: 90, bend: 4, bendTime: 60, decay: 520, noise: 0.06, nf: LP, nfreq: 2000, ndecay: 200, level: 0.54 }),
  s('tom-808-mid', '808 mid tom', 'tom', { pitch: 130, bend: 4, bendTime: 50, decay: 420, noise: 0.06, nf: LP, nfreq: 2500, ndecay: 180, level: 0.57 }),
  s('tom-808-high', '808 high tom', 'tom', { pitch: 185, bend: 4, bendTime: 40, decay: 340, noise: 0.06, nf: LP, nfreq: 3000, ndecay: 150, level: 0.61 }),
  s('tom-909-low', '909 low tom', 'tom', { pitch: 95, bend: 9, bendTime: 50, decay: 450, char: 0.35, noise: 0.15, nf: LP, nfreq: 3000, ndecay: 120, click: 0.35, ctone: 0.6, level: 0.64 }),
  s('tom-909-high', '909 high tom', 'tom', { pitch: 160, bend: 9, bendTime: 40, decay: 360, char: 0.35, noise: 0.15, nf: LP, nfreq: 3500, ndecay: 100, click: 0.35, ctone: 0.6, level: 0.68 }),
  s('tom-floor', 'Floor tom', 'tom', { model: MO, char: MEMBRANE, timbre: 0.35, pitch: 82, bend: 3, bendTime: 70, decay: 900, click: 0.6, ctone: 0.4, noise: 0.15, nf: LP, nfreq: 900, ndecay: 120, vel: 0.65, level: 0.58 }),
  s('tom-low', 'Low tom', 'tom', { model: MO, char: MEMBRANE, timbre: 0.38, pitch: 105, bend: 3, bendTime: 60, decay: 750, click: 0.6, ctone: 0.45, noise: 0.15, nf: LP, nfreq: 1100, ndecay: 100, vel: 0.65, level: 0.62 }),
  s('tom-mid', 'Mid tom', 'tom', { model: MO, char: MEMBRANE, timbre: 0.4, pitch: 140, bend: 3, bendTime: 50, decay: 620, click: 0.6, ctone: 0.5, noise: 0.15, nf: LP, nfreq: 1400, ndecay: 90, vel: 0.65, level: 0.67 }),
  s('tom-high', 'High tom', 'tom', { model: MO, char: MEMBRANE, timbre: 0.42, pitch: 185, bend: 3, bendTime: 45, decay: 520, click: 0.6, ctone: 0.55, noise: 0.15, nf: LP, nfreq: 1800, ndecay: 80, vel: 0.65, level: 0.63 }),
  s('tom-electro', 'Electro tom', 'tom', { pitch: 120, bend: 14, bendTime: 220, decay: 600, char: 0.45, noise: 0.35, nf: BP, nfreq: 1500, nres: 0.2, ndecay: 200, sweep: 0.3, click: 0.3, level: 0.62 }),
  s('tom-electro-high', 'Electro high tom', 'tom', { pitch: 190, bend: 14, bendTime: 200, decay: 520, char: 0.45, noise: 0.35, nf: BP, nfreq: 2200, nres: 0.2, ndecay: 180, sweep: 0.3, click: 0.3, level: 0.64 }),
  s('tom-lofi', 'Dusty tom', 'tom', { model: MO, char: MEMBRANE, timbre: 0.3, pitch: 120, bend: 2, bendTime: 50, decay: 450, click: 0.4, ctone: 0.35, drive: 0.25, color: -0.5, level: 0.42 }),

  // ---- percussion
  s('cowbell-808', '808 cowbell', 'perc', { model: ME, pitch: 540, char: 0, timbre: 0.23, decay: 320, drive: 0.25, level: 0.61 }),
  s('cowbell', 'Cowbell', 'perc', { model: FM, char: 0.39, timbre: 0.5, pitch: 560, decay: 380, click: 0.6, ctone: 0.8, level: 0.26 }),
  s('claves-808', '808 claves', 'perc', { model: MO, char: BAR, timbre: 0.5, pitch: 2500, decay: 40, click: 0.3, ctone: 0.9, level: 1.04 }),
  s('claves', 'Claves', 'perc', { model: MO, char: BAR, timbre: 0.55, pitch: 2100, decay: 90, click: 0.5, ctone: 0.9, level: 0.87 }),
  s('woodblock-high', 'Woodblock high', 'perc', { model: MO, char: BAR, timbre: 0.55, pitch: 950, decay: 80, click: 0.6, ctone: 0.75, level: 0.76 }),
  s('woodblock-low', 'Woodblock low', 'perc', { model: MO, char: BAR, timbre: 0.55, pitch: 680, decay: 95, click: 0.6, ctone: 0.7, level: 0.76 }),
  s('shaker', 'Shaker', 'perc', { body: 0, noise: 0.85, nf: BP, nfreq: 7000, nres: 0.2, ndecay: 55, nshape: SWELL, vel: 0.7, level: 1.67 }),
  s('shaker-short', 'Shaker tick', 'perc', { body: 0, noise: 0.8, nf: HP, nfreq: 6500, nres: 0.1, ndecay: 45, level: 0.96 }),
  s('maracas-808', '808 maracas', 'perc', { body: 0, noise: 0.85, nf: HP, nfreq: 5000, ndecay: 35, level: 0.97 }),
  s('tambourine', 'Tambourine', 'perc', { model: ME, pitch: 780, char: 0.95, timbre: 0.65, decay: 260, noise: 0.6, nf: HP, nfreq: 6500, ndecay: 220, click: 0.35, ctone: 0.8, level: 0.69 }),
  s('triangle', 'Triangle', 'perc', { model: MO, char: 0.9, timbre: 0.85, pitch: 1380, decay: 3500, click: 0.15, ctone: 1, choke: MUTES, level: 0.35 }),
  s('triangle-mute', 'Triangle mute', 'perc', { model: MO, char: 0.9, timbre: 0.85, pitch: 1380, decay: 120, click: 0.15, ctone: 1, choke: MUTES, level: 0.76 }),
  s('agogo-high', 'Agogo high', 'perc', { model: MO, char: BELL, timbre: 0.5, pitch: 920, decay: 520, click: 0.4, ctone: 0.85, level: 0.37 }),
  s('agogo-low', 'Agogo low', 'perc', { model: MO, char: BELL, timbre: 0.5, pitch: 690, decay: 600, click: 0.4, ctone: 0.8, level: 0.35 }),
  s('conga-808-high', '808 high conga', 'perc', { pitch: 370, bend: 2, bendTime: 15, decay: 160, level: 0.37 }),
  s('conga-808-mid', '808 mid conga', 'perc', { pitch: 250, bend: 2, bendTime: 15, decay: 190, level: 0.34 }),
  s('conga-808-low', '808 low conga', 'perc', { pitch: 165, bend: 2, bendTime: 20, decay: 230, level: 0.32 }),
  s('rimclick', 'Rim click', 'perc', { model: MO, char: BAR, timbre: 0.7, pitch: 1650, decay: 18, click: 0.7, ctone: 0.9, level: 0.8 }),
  s('vibraslap', 'Rattle', 'perc', { model: ME, pitch: 900, char: 1, timbre: 0.4, decay: 900, noise: 0.5, nf: BP, nfreq: 3000, nres: 0.3, ndecay: 900, nshape: CLAP, level: 0.42 }),
  s('scratch', 'Guiro', 'perc', { model: MO, char: BAR, timbre: 0.7, pitch: 1200, decay: 25, body: 0.4, noise: 0.9, nf: BP, nfreq: 3200, nres: 0.4, ndecay: 160, nshape: GATE, sweep: 0.3, level: 1.01 }),

  // ---- world
  s('conga-open', 'Conga open', 'world', { model: MO, char: 0.12, timbre: 0.45, pitch: 215, bend: 2, bendTime: 30, decay: 380, click: 0.5, ctone: 0.55, vel: 0.65, level: 0.6 }),
  s('conga-slap', 'Conga slap', 'world', { model: MO, char: 0.12, timbre: 0.85, pitch: 300, bend: 1, decay: 110, body: 0.7, noise: 0.5, nf: BP, nfreq: 3000, nres: 0.1, ndecay: 50, click: 1, ctone: 0.85, level: 0.66 }),
  s('tumba', 'Tumba', 'world', { model: MO, char: 0.12, timbre: 0.4, pitch: 160, bend: 2, bendTime: 35, decay: 450, click: 0.45, ctone: 0.5, level: 0.52 }),
  s('bongo-high', 'Bongo high', 'world', { model: MO, char: 0.15, timbre: 0.6, pitch: 420, bend: 2, bendTime: 20, decay: 200, click: 0.7, ctone: 0.75, level: 0.61 }),
  s('bongo-low', 'Bongo low', 'world', { model: MO, char: 0.15, timbre: 0.55, pitch: 300, bend: 2, bendTime: 25, decay: 240, click: 0.65, ctone: 0.7, level: 0.56 }),
  s('timbale', 'Timbale', 'world', { model: MO, char: TUNED_SKIN, timbre: 0.75, pitch: 410, bend: 1, decay: 600, body: 0.9, noise: 0.25, nf: BP, nfreq: 4000, ndecay: 150, click: 0.9, ctone: 0.9, level: 0.6 }),
  s('tabla-na', 'Tabla na', 'world', { model: MO, char: HARMONIC, timbre: 0.6, pitch: 380, decay: 650, click: 0.5, ctone: 0.85, level: 0.63 }),
  s('tabla-tin', 'Tabla tin', 'world', { model: MO, char: HARMONIC, timbre: 0.35, pitch: 380, decay: 900, click: 0.25, ctone: 0.6, level: 0.42 }),
  s('tabla-te', 'Tabla te', 'world', { model: MO, char: HARMONIC, timbre: 0.5, pitch: 380, decay: 80, click: 0.6, ctone: 0.8, noise: 0.2, nf: BP, nfreq: 2500, ndecay: 25, level: 0.68 }),
  s('bayan-ge', 'Bayan ge', 'world', { model: MO, char: 0.25, timbre: 0.25, pitch: 95, bend: -6, bendTime: 260, decay: 900, click: 0.4, ctone: 0.35, level: 0.37 }),
  s('bayan-ke', 'Bayan ke', 'world', { model: MO, char: 0.25, timbre: 0.4, pitch: 110, decay: 90, click: 0.6, ctone: 0.4, noise: 0.2, nf: LP, nfreq: 800, ndecay: 40, level: 0.84 }),
  s('djembe-bass', 'Djembe bass', 'world', { model: MO, char: MEMBRANE, timbre: 0.2, pitch: 78, bend: 3, bendTime: 30, decay: 300, click: 0.5, ctone: 0.3, noise: 0.2, nf: LP, nfreq: 500, ndecay: 60, level: 0.46 }),
  s('djembe-tone', 'Djembe tone', 'world', { model: MO, char: 0.1, timbre: 0.5, pitch: 330, bend: 1, decay: 220, click: 0.6, ctone: 0.6, level: 0.57 }),
  s('djembe-slap', 'Djembe slap', 'world', { model: MO, char: 0.1, timbre: 0.9, pitch: 420, decay: 120, body: 0.6, noise: 0.6, nf: BP, nfreq: 2500, nres: 0.15, ndecay: 60, click: 1.1, ctone: 0.85, level: 0.66 }),
  s('cajon-bass', 'Cajón bass', 'world', { model: MO, char: MEMBRANE, timbre: 0.2, pitch: 85, bend: 2, bendTime: 25, decay: 200, click: 0.5, ctone: 0.3, noise: 0.25, nf: LP, nfreq: 600, ndecay: 50, level: 0.54 }),
  s('cajon-slap', 'Cajón slap', 'world', { model: MO, char: MEMBRANE, timbre: 0.6, pitch: 310, decay: 100, body: 0.55, noise: 0.95, nf: BP, nfreq: 3200, nres: 0.05, ndecay: 170, click: 0.8, ctone: 0.7, level: 0.67 }),
  s('talking-drum', 'Talking drum', 'world', { model: MO, char: 0.1, timbre: 0.45, pitch: 190, bend: -7, bendTime: 320, decay: 650, click: 0.5, ctone: 0.6, level: 0.51 }),
  s('udu', 'Udu', 'world', { model: AN, pitch: 140, bend: -9, bendTime: 140, decay: 480, char: 0.05, click: 0.15, ctone: 0.25, noise: 0.15, nf: LP, nfreq: 500, ndecay: 120, nshape: SWELL, level: 0.39 }),
  s('frame-drum', 'Frame drum', 'world', { model: MO, char: MEMBRANE, timbre: 0.3, pitch: 115, bend: 2, bendTime: 40, decay: 520, click: 0.45, ctone: 0.45, noise: 0.25, nf: BP, nfreq: 2200, nres: 0.05, ndecay: 70, level: 0.44 }),
  s('taiko', 'Taiko', 'world', { model: MO, char: MEMBRANE, timbre: 0.25, pitch: 62, bend: 3, bendTime: 60, decay: 1500, click: 1, ctone: 0.3, noise: 0.35, nf: LP, nfreq: 400, ndecay: 160, drive: 0.15, level: 0.3 }),
  s('slit-drum', 'Slit drum', 'world', { model: MO, char: BAR, timbre: 0.35, pitch: 290, decay: 420, click: 0.4, ctone: 0.5, level: 0.51 }),
  s('timpani', 'Timpani', 'world', { model: MO, char: 0.25, timbre: 0.3, pitch: 98, bend: 1, bendTime: 150, decay: 3200, click: 0.25, ctone: 0.25, noise: 0.15, nf: LP, nfreq: 600, ndecay: 100, level: 0.33 }),
  s('gong', 'Gong', 'world', { model: FM, char: 0.375, timbre: 0.5, pitch: 85, decay: 5000, click: 0.2, ctone: 0.2, noise: 0.25, nf: LP, nfreq: 900, ndecay: 2500, nshape: SWELL, level: 0.29 }),
  s('temple-block', 'Temple block', 'world', { model: MO, char: 0.55, timbre: 0.5, pitch: 520, decay: 140, click: 0.6, ctone: 0.7, level: 0.86 }),

  // ---- tuned (put one on a key range to play it as an instrument)
  s('bass-808', '808 bass', 'tuned', { pitch: 65.4, bend: 5, bendTime: 50, decay: 2000, char: 0.12, click: 0.15, ctone: 0.4, drive: 0.3, vel: 0.3, level: 0.26 }),
  s('marimba', 'Marimba', 'tuned', { model: FM, char: 0.75, timbre: 0.3, pitch: 261.6, decay: 900, click: 0.3, ctone: 0.4, level: 0.34 }),
  s('xylophone', 'Xylophone', 'tuned', { model: MO, char: BAR, timbre: 0.45, pitch: 523.3, decay: 700, click: 0.45, ctone: 0.8, level: 0.52 }),
  s('glockenspiel', 'Glockenspiel', 'tuned', { model: FM, char: 0.84, timbre: 0.35, pitch: 1046.5, decay: 2200, click: 0.25, ctone: 1, level: 0.31 }),
  s('vibes', 'Vibes', 'tuned', { model: FM, char: 0.75, timbre: 0.18, pitch: 349.2, decay: 3500, click: 0.15, ctone: 0.6, level: 0.3 }),
  s('steel-pan', 'Steel pan', 'tuned', { model: MO, char: HARMONIC, timbre: 0.55, pitch: 392, decay: 1600, click: 0.3, ctone: 0.7, level: 0.5 }),
  s('kalimba', 'Kalimba', 'tuned', { model: FM, char: 0.95, timbre: 0.25, pitch: 440, decay: 1100, click: 0.4, ctone: 0.7, level: 0.33 }),
  s('bell', 'Bell', 'tuned', { model: MO, char: BELL, timbre: 0.55, pitch: 330, decay: 4500, click: 0.2, ctone: 0.8, level: 0.45 }),
  s('pluck', 'Plucked string', 'tuned', { model: ST, char: 0.3, timbre: 0, pitch: 220, decay: 2500, click: 0.1, ctone: 0.8, level: 0.66 }),
  s('koto', 'Koto', 'tuned', { model: ST, char: 0.1, timbre: 0, pitch: 293.7, bend: 0.5, bendTime: 80, decay: 1800, click: 0.3, ctone: 0.9, level: 0.72 }),
  s('berimbau', 'Berimbau', 'tuned', { model: ST, char: 0.15, timbre: 0.05, pitch: 110, bend: -2, bendTime: 200, decay: 1400, click: 0.5, ctone: 0.7, drive: 0.2, level: 0.51 }),
  s('sub-drop', 'Sub drop', 'tuned', { pitch: 55, bend: 24, bendTime: 600, decay: 2500, vel: 0.2, level: 0.3 }),

  // ---- fx
  s('zap', 'Zap', 'fx', { pitch: 180, bend: 48, bendTime: 110, decay: 220, char: 0.5, level: 0.56 }),
  s('laser', 'Laser', 'fx', { model: FM, char: 0.5, timbre: 0.6, pitch: 300, bend: 48, bendTime: 280, decay: 450, level: 0.32 }),
  s('rise', 'Riser blip', 'fx', { pitch: 1200, bend: -24, bendTime: 180, decay: 260, char: 0.4, level: 0.5 }),
  s('blip', 'Blip', 'fx', { pitch: 1320, decay: 70, char: 0.5, click: 0.2, ctone: 0.9, level: 0.94 }),
  s('bit-hit', 'Bit hit', 'fx', { pitch: 260, bend: 24, bendTime: 12, decay: 110, char: 1, drive: 0.8, level: 0.23 }),
  s('glitch', 'Glitch', 'fx', { model: ME, pitch: 2600, char: 1, timbre: 0.3, decay: 30, noise: 0.6, nf: BP, nfreq: 1800, nres: 0.8, ndecay: 40, nshape: CLAP, drive: 0.9, level: 0.65 }),
  s('impact', 'Impact', 'fx', { pitch: 38, bend: 24, bendTime: 180, decay: 2800, click: 0.8, ctone: 0.3, noise: 0.7, nf: LP, nfreq: 900, nres: 0.2, ndecay: 1600, sweep: 0.6, drive: 0.5, color: -0.3, level: 0.18 }),
  s('noise-riser', 'Noise riser', 'fx', { body: 0, noise: 1, nf: BP, nfreq: 2500, nres: 0.4, ndecay: 2500, nshape: SWELL, sweep: -0.8, level: 1.53 }),
  s('vinyl-pop', 'Vinyl pop', 'fx', { body: 0, click: 1.2, ctone: 0.55, noise: 0.3, nf: BP, nfreq: 2500, nres: 0.3, ndecay: 6, color: -0.4, vel: 0, level: 1.67 }),
  s('metal-hit', 'Metal hit', 'fx', { model: MO, char: 0.85, timbre: 0.75, pitch: 210, decay: 1600, click: 0.8, ctone: 0.7, noise: 0.3, nf: HP, nfreq: 3000, ndecay: 200, drive: 0.4, level: 0.31 }),
  s('drip', 'Water drop', 'fx', { pitch: 600, bend: -14, bendTime: 35, decay: 90, level: 0.7 }),
  s('karplus-tom', 'Karplus tom', 'fx', { model: ST, char: 0.7, timbre: 0.5, pitch: 120, bend: 3, bendTime: 60, decay: 500, click: 0.3, ctone: 0.4, level: 0.78 }),
]

/** A sound with every param filled in (its own values over the defaults). */
export const fullParams = (s: DrumSound): Record<string, number> => ({ ...drumDefaults(), ...s.params })
export const drumSound = (id: string) => DRUM_SOUNDS.find((s) => s.id === id)

/** Changes to a sound by param name (a kit's take on it: tuned, panned, darker). */
export type DrumTweak = P
/** A library sound's full params with `tweak` laid over them. Throws on an unknown id (the tables are static). */
export function soundParams(id: string, tweak: DrumTweak = {}): Record<string, number> {
  const s = drumSound(id)
  if (!s) throw new Error(`no drum sound ${id}`)
  const out = fullParams(s)
  for (const [k, v] of Object.entries(tweak)) out[String(ID[k as keyof typeof ID])] = v
  return out
}
