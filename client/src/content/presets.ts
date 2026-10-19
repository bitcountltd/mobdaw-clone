// Built-in sounds: finnwave patches, drum kits (built from the drum synth's library, content/drumSounds.ts) and effect
// chains, plus helpers that put them on a track.
//
// How the finnwave params were chosen (engine/crates/dsp/src/finnwave.rs):
// - finnwave's `rolloff` b sets harmonic k to e^(-kb): ~0.05 is a buzzy, saw-like spectrum, ~0.3 a bright reed, ~1 a soft
//   flute-like tone, 3 nearly a sine. `env→rolloff` adds `amount·(1 − env)` to b, so a note is brightest at the envelope's
//   peak and darkens as it decays (a plucked string or an electric piano), and a slow attack opens up as it swells (brass,
//   pads). Loudness stays within ~2× across rolloffs, except near-sines, which get a little more gain.
import type * as Y from 'yjs'
import {
  COMPRESSOR, DELAY, DEVICES, DRUM_SYNTH, EQ, FINNWAVE, REVERB, SIMPLE_FILTER, TREMOLO,
  addDevice, addDrum, deleteDevice, devicesMap, getDevices, isDrum, setParam, updateDevice,
} from '@mobdaw/shared'
import { soundParams, type DrumTweak } from './drumSounds'

export type InstrumentCategory = 'keys' | 'bass' | 'lead' | 'pad' | 'pluck' | 'fx'
export type InstrumentPreset = { id: string; name: string; type: number; params: Record<string, number>; category: InstrumentCategory }
/** A kit's drum: a drum synth on `key`, from library sound `sound` (with the kit's tweaks in `params`). */
export type Drum = { name: string; key: number; sound: string; params: Record<string, number> }
export type DrumKit = { id: string; name: string; drums: Drum[] }
export type EffectPreset = { id: string; name: string; devices: { type: number; params: Record<string, number> }[] }

/** finnwave params by name, so the table below reads; turned into the engine's ids by `fw`. */
type Fw = { rolloff: number; env: number; attack: number; decay: number; sustain: number; release: number; gain: number }
const fw = (p: Fw): Record<string, number> => ({ 0: p.rolloff, 1: p.env, 2: p.attack, 3: p.decay, 4: p.sustain, 5: p.release, 6: p.gain })
const inst = (id: string, name: string, category: InstrumentCategory, p: Fw): InstrumentPreset => ({ id, name, type: FINNWAVE, category, params: fw(p) })

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  // keys
  inst('soft-keys', 'Soft keys', 'keys', { rolloff: 0.6, env: 1.6, attack: 3, decay: 1100, sustain: 0.22, release: 450, gain: 0.5 }),
  inst('electric-piano', 'Electric piano', 'keys', { rolloff: 0.9, env: 1.1, attack: 2, decay: 1800, sustain: 0.12, release: 380, gain: 0.55 }),
  inst('organ', 'Organ', 'keys', { rolloff: 0.7, env: 0, attack: 6, decay: 50, sustain: 1, release: 60, gain: 0.4 }),
  // bass
  inst('round-bass', 'Round bass', 'bass', { rolloff: 1.1, env: 1.0, attack: 3, decay: 450, sustain: 0.55, release: 110, gain: 0.85 }),
  inst('sub-bass', 'Sub bass', 'bass', { rolloff: 3, env: 0, attack: 6, decay: 200, sustain: 1, release: 140, gain: 1.4 }),
  inst('finger-bass', 'Finger bass', 'bass', { rolloff: 0.45, env: 2.2, attack: 1, decay: 260, sustain: 0.35, release: 80, gain: 0.7 }),
  // lead
  inst('reed-lead', 'Reed lead', 'lead', { rolloff: 0.22, env: 0.4, attack: 10, decay: 300, sustain: 0.75, release: 180, gain: 0.4 }),
  inst('flute-lead', 'Soft flute', 'lead', { rolloff: 1.4, env: 0.6, attack: 45, decay: 400, sustain: 0.8, release: 220, gain: 0.6 }),
  inst('brass', 'Brassy swell', 'lead', { rolloff: 0.18, env: 2.4, attack: 90, decay: 500, sustain: 0.7, release: 220, gain: 0.4 }),
  // pad
  inst('warm-pad', 'Warm pad', 'pad', { rolloff: 0.55, env: 1.4, attack: 900, decay: 2200, sustain: 0.8, release: 2500, gain: 0.35 }),
  inst('strings', 'String section', 'pad', { rolloff: 0.12, env: 0.9, attack: 380, decay: 900, sustain: 0.85, release: 1000, gain: 0.28 }),
  inst('glass-pad', 'Glass pad', 'pad', { rolloff: 1.8, env: 0.3, attack: 1500, decay: 3000, sustain: 0.9, release: 4000, gain: 0.55 }),
  // pluck
  inst('pluck', 'Bright pluck', 'pluck', { rolloff: 0.08, env: 2.6, attack: 0, decay: 240, sustain: 0, release: 240, gain: 0.55 }),
  inst('music-box', 'Music box', 'pluck', { rolloff: 1.6, env: 0.5, attack: 0, decay: 2400, sustain: 0, release: 2400, gain: 0.7 }),
  inst('kalimba', 'Kalimba', 'pluck', { rolloff: 0.9, env: 2.0, attack: 0, decay: 700, sustain: 0, release: 700, gain: 0.6 }),
  // fx
  inst('buzz-riser', 'Buzz riser', 'fx', { rolloff: 0.02, env: 3, attack: 4000, decay: 0, sustain: 1, release: 3000, gain: 0.3 }),
  inst('drone', 'Dark drone', 'fx', { rolloff: 2.4, env: 0.4, attack: 2500, decay: 5000, sustain: 1, release: 6000, gain: 0.9 }),
]

/** A kit's drum: a library sound (content/drumSounds.ts), on a key, with the kit's own tweaks. */
const drum = (name: string, key: number, sound: string, tweak: DrumTweak = {}): Drum => ({ name, key, sound, params: soundParams(sound, tweak) })

/** General MIDI drum keys the kits use. */
export const GM = {
  kick: 36, rim: 37, snare: 38, clap: 39, snare2: 40, floorTom: 41, closedHat: 42, floorTom2: 43, pedalHat: 44, lowTom: 45,
  openHat: 46, midTom: 47, midTom2: 48, crash: 49, highTom: 50, ride: 51, china: 52, rideBell: 53, tambourine: 54, splash: 55,
  cowbell: 56, crash2: 57, vibraslap: 58, bongoHigh: 60, bongoLow: 61, congaMute: 62, congaOpen: 63, congaLow: 64,
  timbaleHigh: 65, timbaleLow: 66, agogoHigh: 67, agogoLow: 68, cabasa: 69, shaker: 70, guiro: 73, claves: 75,
  woodHigh: 76, woodLow: 77, triangleMute: 80, triangleOpen: 81,
} as const

// Stereo placement shared by the kits: the drummer's view, hats a little right, toms sweeping left to right.
const HAT = 0.25, CYM_L = -0.35, CYM_R = 0.4, TOM = [0.35, 0.15, -0.1, -0.3]

/**
 * The kits. Every kit has the core keys (kick, rim, snare, clap, closed and open hat, two toms) so a GM pattern plays on any
 * of them; most go on to cymbals and percussion. The first is the default for new drum tracks and MIDI imports.
 */
export const DRUM_KITS: DrumKit[] = [
  {
    id: 'tape', name: 'Tape kit', drums: [
      drum('kick', GM.kick, 'kick-acoustic', { color: -0.25 }),
      drum('sidestick', GM.rim, 'sidestick', { color: -0.2 }),
      drum('snare', GM.snare, 'snare-acoustic', { color: -0.2, drive: 0.1 }),
      drum('clap', GM.clap, 'clap-hand', { color: -0.2 }),
      drum('closed hat', GM.closedHat, 'hat-closed', { pan: HAT, color: -0.3 }),
      drum('pedal hat', GM.pedalHat, 'hat-pedal', { pan: HAT, color: -0.3 }),
      drum('open hat', GM.openHat, 'hat-open', { pan: HAT, color: -0.3 }),
      drum('floor tom', GM.floorTom, 'tom-floor', { pan: TOM[3], color: -0.2 }),
      drum('low tom', GM.lowTom, 'tom-low', { pan: TOM[2], color: -0.2 }),
      drum('mid tom', GM.midTom, 'tom-mid', { pan: TOM[1], color: -0.2 }),
      drum('high tom', GM.highTom, 'tom-high', { pan: TOM[0], color: -0.2 }),
      drum('crash', GM.crash, 'crash', { pan: CYM_L, color: -0.3 }),
      drum('ride', GM.ride, 'ride', { pan: CYM_R, color: -0.3 }),
      drum('tambourine', GM.tambourine, 'tambourine', { pan: 0.5, color: -0.3 }),
      drum('shaker', GM.shaker, 'shaker', { pan: -0.4, color: -0.2 }),
    ],
  },
  {
    id: '808ish', name: '808', drums: [
      drum('kick', GM.kick, 'kick-808'),
      drum('rim', GM.rim, 'rim-808'),
      drum('snare', GM.snare, 'snare-808'),
      drum('clap', GM.clap, 'clap-808'),
      drum('closed hat', GM.closedHat, 'hat-808-closed', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-808-open', { pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-808-low', { pan: TOM[3] }),
      drum('mid tom', GM.midTom, 'tom-808-mid', { pan: TOM[1] }),
      drum('high tom', GM.highTom, 'tom-808-high', { pan: TOM[0] }),
      drum('cymbal', GM.crash, 'cym-808', { pan: CYM_L }),
      drum('cowbell', GM.cowbell, 'cowbell-808', { pan: 0.3 }),
      drum('claves', GM.claves, 'claves-808', { pan: -0.3 }),
      drum('maracas', GM.shaker, 'maracas-808', { pan: 0.4 }),
      drum('high conga', GM.congaOpen, 'conga-808-high', { pan: 0.35 }),
      drum('mid conga', GM.congaMute, 'conga-808-mid', { pan: 0.1 }),
      drum('low conga', GM.congaLow, 'conga-808-low', { pan: -0.15 }),
    ],
  },
  {
    id: '909', name: '909', drums: [
      drum('kick', GM.kick, 'kick-909'),
      drum('rim', GM.rim, 'rim-808', { pitch: 480, drive: 0.6 }),
      drum('snare', GM.snare, 'snare-909'),
      drum('clap', GM.clap, 'clap-909'),
      drum('closed hat', GM.closedHat, 'hat-909-closed', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-909-open', { pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-909-low', { pan: TOM[3] }),
      drum('mid tom', GM.midTom, 'tom-909-low', { pitch: 125, pan: TOM[1] }),
      drum('high tom', GM.highTom, 'tom-909-high', { pan: TOM[0] }),
      drum('crash', GM.crash, 'crash', { drive: 0.3, pan: CYM_L }),
      drum('ride', GM.ride, 'ride-fm', { pan: CYM_R }),
    ],
  },
  {
    id: '606', name: '606', drums: [
      drum('kick', GM.kick, 'kick-606'),
      drum('rim', GM.rim, 'rim-808', { pitch: 520, decay: 25 }),
      drum('snare', GM.snare, 'snare-606'),
      drum('clap', GM.clap, 'clap-tight'),
      drum('closed hat', GM.closedHat, 'hat-606-closed', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-606-open', { pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-808-mid', { pitch: 120, decay: 300, pan: TOM[2] }),
      drum('high tom', GM.midTom, 'tom-808-high', { pitch: 190, decay: 260, pan: TOM[0] }),
      drum('cymbal', GM.crash, 'cym-808', { pitch: 240, decay: 1300, pan: CYM_L }),
    ],
  },
  {
    id: 'rhythm-box', name: 'Rhythm box', drums: [
      drum('kick', GM.kick, 'kick-cr78'),
      drum('rim', GM.rim, 'rimclick'),
      drum('snare', GM.snare, 'snare-cr78'),
      drum('clap', GM.clap, 'snap', { color: -0.3 }),
      drum('hat', GM.closedHat, 'hat-noise', { color: -0.3, pan: HAT }),
      drum('open hat', GM.openHat, 'hat-noise-open', { ndecay: 250, color: -0.3, pan: HAT }),
      drum('low bongo', GM.lowTom, 'conga-808-mid', { pan: -0.25 }),
      drum('high bongo', GM.midTom, 'conga-808-high', { pitch: 420, pan: 0.25 }),
      drum('cymbal', GM.crash, 'cym-808', { color: -0.4, pan: CYM_L }),
      drum('tambourine', GM.tambourine, 'tambourine', { color: -0.4, pan: 0.45 }),
      drum('cowbell', GM.cowbell, 'cowbell-808', { color: -0.3, pan: 0.3 }),
      drum('guiro', GM.guiro, 'scratch', { pan: -0.4 }),
      drum('claves', GM.claves, 'claves', { pan: -0.3 }),
      drum('maracas', GM.shaker, 'maracas-808', { pan: 0.4 }),
    ],
  },
  {
    id: 'linn', name: '80s drum machine', drums: [
      drum('kick', GM.kick, 'kick-linn'),
      drum('sidestick', GM.rim, 'sidestick'),
      drum('snare', GM.snare, 'snare-linn'),
      drum('clap', GM.clap, 'clap-909', { nfreq: 1200 }),
      drum('closed hat', GM.closedHat, 'hat-closed', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-open', { decay: 600, ndecay: 450, pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-low', { pan: TOM[3] }),
      drum('mid tom', GM.midTom, 'tom-mid', { pan: TOM[1] }),
      drum('high tom', GM.highTom, 'tom-high', { pan: TOM[0] }),
      drum('crash', GM.crash, 'crash', { pan: CYM_L }),
      drum('ride', GM.ride, 'ride', { pan: CYM_R }),
      drum('tambourine', GM.tambourine, 'tambourine', { pan: 0.45 }),
      drum('cowbell', GM.cowbell, 'cowbell', { pan: 0.3 }),
      drum('conga', GM.congaOpen, 'conga-open', { pan: 0.35 }),
    ],
  },
  {
    id: 'rock', name: 'Arena rock', drums: [
      drum('kick', GM.kick, 'kick-rock'),
      drum('rimshot', GM.rim, 'rim-acoustic'),
      drum('snare', GM.snare, 'snare-rock'),
      drum('clap', GM.clap, 'clap-big'),
      drum('gated snare', GM.snare2, 'snare-gated'),
      drum('closed hat', GM.closedHat, 'hat-closed', { pan: HAT }),
      drum('pedal hat', GM.pedalHat, 'hat-pedal', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-open', { pan: HAT }),
      drum('floor tom', GM.floorTom, 'tom-floor', { drive: 0.25, pan: TOM[3] }),
      drum('low tom', GM.lowTom, 'tom-low', { drive: 0.2, pan: TOM[2] }),
      drum('mid tom', GM.midTom, 'tom-mid', { drive: 0.2, pan: TOM[1] }),
      drum('high tom', GM.highTom, 'tom-high', { drive: 0.2, pan: TOM[0] }),
      drum('crash', GM.crash, 'crash', { pan: CYM_L }),
      drum('crash 2', GM.crash2, 'crash-dark', { pan: 0.55 }),
      drum('china', GM.china, 'china', { pan: -0.6 }),
      drum('ride', GM.ride, 'ride', { pan: CYM_R }),
      drum('ride bell', GM.rideBell, 'ride-bell', { pan: CYM_R }),
      drum('splash', GM.splash, 'splash', { pan: -0.15 }),
    ],
  },
  {
    id: 'jazz', name: 'Jazz brushes', drums: [
      drum('kick', GM.kick, 'kick-jazz'),
      drum('cross-stick', GM.rim, 'sidestick', { pitch: 700, color: -0.2 }),
      drum('brush', GM.snare, 'snare-brush'),
      drum('snap', GM.clap, 'snap'),
      drum('swish', GM.snare2, 'snare-brush-swish'),
      drum('closed hat', GM.closedHat, 'hat-closed', { decay: 110, timbre: 0.6, color: -0.35, pan: HAT }),
      drum('pedal hat', GM.pedalHat, 'hat-pedal', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-half', { color: -0.3, pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-low', { pitch: 130, timbre: 0.3, click: 0.3, pan: TOM[3] }),
      drum('high tom', GM.midTom, 'tom-high', { pitch: 205, timbre: 0.3, click: 0.3, pan: TOM[0] }),
      drum('crash', GM.crash, 'crash-dark', { pan: CYM_L }),
      drum('ride', GM.ride, 'ride', { timbre: 0.5, color: -0.25, pan: CYM_R }),
      drum('ride bell', GM.rideBell, 'ride-bell', { color: -0.2, pan: CYM_R }),
    ],
  },
  {
    id: 'dusty', name: 'Dusty', drums: [
      drum('kick', GM.kick, 'kick-lofi'),
      drum('rim', GM.rim, 'sidestick', { color: -0.6, drive: 0.2 }),
      drum('snare', GM.snare, 'snare-lofi'),
      drum('clap', GM.clap, 'clap-lofi'),
      drum('closed hat', GM.closedHat, 'hat-lofi', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-lofi', { decay: 380, ndecay: 300, pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-lofi', { pitch: 100, pan: TOM[3] }),
      drum('mid tom', GM.midTom, 'tom-lofi', { pan: TOM[1] }),
      drum('shaker', GM.shaker, 'shaker', { color: -0.5, pan: -0.35 }),
      drum('crackle', 60, 'vinyl-pop'),
    ],
  },
  {
    id: 'trap', name: 'Trap', drums: [
      drum('808', GM.kick, 'kick-trap'),
      drum('rim', GM.rim, 'rim-808'),
      drum('snare', GM.snare, 'snare-trap'),
      drum('clap', GM.clap, 'clap-big', { ndecay: 300 }),
      drum('closed hat', GM.closedHat, 'hat-trap', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-trap', { decay: 300, ndecay: 260, pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-808-low', { pan: TOM[3] }),
      drum('high tom', GM.midTom, 'tom-808-high', { pan: TOM[0] }),
      drum('crash', GM.crash, 'cym-reverse', { pan: CYM_L }),
      drum('perc', GM.cowbell, 'zap', { pan: 0.3 }),
      drum('snap', GM.claves, 'snap', { pan: -0.3 }),
    ],
  },
  {
    id: 'techno', name: 'Techno', drums: [
      drum('kick', GM.kick, 'kick-techno'),
      drum('rim', GM.rim, 'rim-808', { drive: 0.7 }),
      drum('snare', GM.snare, 'snare-808-snappy'),
      drum('clap', GM.clap, 'clap-909', { ndecay: 380 }),
      drum('closed hat', GM.closedHat, 'hat-909-closed', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-909-open', { pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-909-low', { pan: TOM[3] }),
      drum('high tom', GM.midTom, 'tom-909-high', { pan: TOM[0] }),
      drum('crash', GM.crash, 'crash', { drive: 0.4, pan: CYM_L }),
      drum('ride', GM.ride, 'ride-fm', { pan: CYM_R }),
      drum('cowbell', GM.cowbell, 'cowbell-808', { drive: 0.6, pan: 0.3 }),
      drum('shaker', GM.shaker, 'shaker-short', { pan: -0.4 }),
      drum('glitch', 60, 'glitch', { pan: 0.2 }),
    ],
  },
  {
    id: 'house', name: 'House', drums: [
      drum('kick', GM.kick, 'kick-house'),
      drum('rim', GM.rim, 'rim-808'),
      drum('snare', GM.snare, 'snare-808'),
      drum('clap', GM.clap, 'clap-909', { ndecay: 300 }),
      drum('closed hat', GM.closedHat, 'hat-909-closed', { decay: 45, pan: HAT }),
      drum('open hat', GM.openHat, 'hat-909-open', { decay: 350, ndecay: 300, pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-808-low', { pan: TOM[3] }),
      drum('high tom', GM.midTom, 'tom-808-high', { pan: TOM[0] }),
      drum('crash', GM.crash, 'crash', { pan: CYM_L }),
      drum('ride', GM.ride, 'ride', { pan: CYM_R }),
      drum('tambourine', GM.tambourine, 'tambourine', { pan: 0.45 }),
      drum('shaker', GM.shaker, 'shaker', { pan: -0.4 }),
      drum('high conga', GM.congaOpen, 'conga-808-high', { pan: 0.35 }),
      drum('low conga', GM.congaLow, 'conga-808-low', { pan: -0.2 }),
    ],
  },
  {
    id: 'minimal', name: 'Minimal click', drums: [
      drum('kick', GM.kick, 'kick-tight'),
      drum('rim', GM.rim, 'rimclick'),
      drum('snare', GM.snare, 'snare-606', { decay: 60, ndecay: 80 }),
      drum('snap', GM.clap, 'snap'),
      drum('closed hat', GM.closedHat, 'hat-noise', { ndecay: 25, pan: HAT }),
      drum('open hat', GM.openHat, 'hat-noise-open', { ndecay: 180, pan: HAT }),
      drum('low tom', GM.lowTom, 'karplus-tom', { pan: TOM[3] }),
      drum('high tom', GM.midTom, 'karplus-tom', { pitch: 180, pan: TOM[0] }),
      drum('blip', GM.cowbell, 'blip', { pan: 0.3 }),
      drum('wood', GM.woodHigh, 'woodblock-high', { pan: -0.3 }),
      drum('drop', GM.claves, 'drip', { pan: 0.4 }),
    ],
  },
  {
    id: 'electro', name: 'Electro', drums: [
      drum('kick', GM.kick, 'kick-simmons'),
      drum('rim', GM.rim, 'rim-808'),
      drum('snare', GM.snare, 'snare-electro'),
      drum('clap', GM.clap, 'clap-808'),
      drum('closed hat', GM.closedHat, 'hat-808-closed', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-808-open', { pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-electro', { pan: TOM[3] }),
      drum('mid tom', GM.midTom, 'tom-electro', { pitch: 150, pan: TOM[1] }),
      drum('high tom', GM.highTom, 'tom-electro-high', { pan: TOM[0] }),
      drum('crash', GM.crash, 'cym-808', { pan: CYM_L }),
      drum('cowbell', GM.cowbell, 'cowbell-808', { pan: 0.3 }),
      drum('zap', 60, 'zap', { pan: -0.3 }),
      drum('laser', 61, 'laser', { pan: 0.3 }),
    ],
  },
  {
    id: 'industrial', name: 'Industrial', drums: [
      drum('kick', GM.kick, 'kick-hard'),
      drum('clank', GM.rim, 'metal-hit', { decay: 400 }),
      drum('snare', GM.snare, 'snare-karplus', { drive: 0.6 }),
      drum('clap', GM.clap, 'clap-big', { drive: 0.6 }),
      drum('closed hat', GM.closedHat, 'hat-fm', { pan: HAT }),
      drum('open hat', GM.openHat, 'hat-fm', { decay: 300, ndecay: 250, pan: HAT }),
      drum('low tom', GM.lowTom, 'tom-electro', { drive: 0.7, pan: TOM[3] }),
      drum('high tom', GM.midTom, 'tom-electro-high', { drive: 0.7, pan: TOM[0] }),
      drum('crash', GM.crash, 'china', { pan: CYM_L }),
      drum('bit', GM.cowbell, 'bit-hit', { pan: 0.3 }),
      drum('glitch', 60, 'glitch', { pan: -0.3 }),
      drum('impact', 61, 'impact'),
    ],
  },
  {
    id: 'latin', name: 'Latin percussion', drums: [
      drum('kick', GM.kick, 'kick-jazz', { decay: 400 }),
      drum('rim', GM.rim, 'rimclick'),
      drum('timbale', GM.snare, 'timbale'),
      drum('clap', GM.clap, 'clap-hand'),
      drum('shaker', GM.closedHat, 'shaker-short', { pan: 0.3 }),
      drum('long shaker', GM.openHat, 'shaker', { ndecay: 120, pan: 0.3 }),
      drum('tumba', GM.lowTom, 'tumba', { pan: -0.35 }),
      drum('conga', GM.midTom, 'conga-open', { pan: -0.1 }),
      drum('cowbell', GM.cowbell, 'cowbell', { pan: 0.2 }),
      drum('bongo high', GM.bongoHigh, 'bongo-high', { pan: 0.25 }),
      drum('bongo low', GM.bongoLow, 'bongo-low', { pan: 0.15 }),
      drum('conga slap', GM.congaMute, 'conga-slap', { pan: -0.1 }),
      drum('conga open', GM.congaOpen, 'conga-open', { pitch: 240, pan: -0.1 }),
      drum('tumba open', GM.congaLow, 'tumba', { pan: -0.35 }),
      drum('timbale high', GM.timbaleHigh, 'timbale', { pitch: 470, pan: 0.4 }),
      drum('timbale low', GM.timbaleLow, 'timbale', { pitch: 360, pan: 0.3 }),
      drum('agogo high', GM.agogoHigh, 'agogo-high', { pan: -0.4 }),
      drum('agogo low', GM.agogoLow, 'agogo-low', { pan: -0.4 }),
      drum('guiro', GM.guiro, 'scratch', { pan: 0.45 }),
      drum('claves', GM.claves, 'claves', { pan: -0.25 }),
      drum('wood high', GM.woodHigh, 'woodblock-high', { pan: 0.35 }),
      drum('wood low', GM.woodLow, 'woodblock-low', { pan: 0.35 }),
      drum('triangle mute', GM.triangleMute, 'triangle-mute', { pan: 0.5 }),
      drum('triangle', GM.triangleOpen, 'triangle', { pan: 0.5 }),
    ],
  },
  {
    id: 'west-africa', name: 'West African', drums: [
      drum('djembe bass', GM.kick, 'djembe-bass'),
      drum('bell', GM.rim, 'agogo-low', { pitch: 760, pan: 0.35 }),
      drum('djembe slap', GM.snare, 'djembe-slap', { pan: -0.1 }),
      drum('clap', GM.clap, 'clap-hand'),
      drum('shaker', GM.closedHat, 'shaker-short', { pan: 0.3 }),
      drum('long shaker', GM.openHat, 'shaker', { ndecay: 150, pan: 0.3 }),
      drum('talking drum', GM.lowTom, 'talking-drum', { pan: -0.3 }),
      drum('djembe tone', GM.midTom, 'djembe-tone', { pan: -0.1 }),
      drum('dundun', GM.floorTom, 'frame-drum', { pitch: 90, decay: 450, pan: 0.2 }),
      drum('bell high', GM.cowbell, 'agogo-high', { pan: 0.4 }),
      drum('udu', GM.congaLow, 'udu', { pan: -0.2 }),
      drum('slit drum', GM.woodLow, 'slit-drum', { pan: 0.25 }),
    ],
  },
  {
    id: 'tabla', name: 'Tabla & hand drums', drums: [
      drum('ge', GM.kick, 'bayan-ge', { pan: -0.2 }),
      drum('te', GM.rim, 'tabla-te', { pan: 0.2 }),
      drum('na', GM.snare, 'tabla-na', { pan: 0.2 }),
      drum('snap', GM.clap, 'snap'),
      drum('shaker', GM.closedHat, 'shaker-short', { pan: 0.35 }),
      drum('tin', GM.openHat, 'tabla-tin', { pan: 0.2 }),
      drum('ke', GM.lowTom, 'bayan-ke', { pan: -0.2 }),
      drum('frame drum', GM.midTom, 'frame-drum', { pan: -0.35 }),
      drum('cajón bass', GM.floorTom, 'cajon-bass'),
      drum('cajón slap', GM.snare2, 'cajon-slap'),
      drum('udu', GM.congaLow, 'udu', { pan: -0.3 }),
      drum('tambourine', GM.tambourine, 'tambourine', { pan: 0.45 }),
    ],
  },
  {
    id: 'orchestra', name: 'Orchestral', drums: [
      drum('bass drum', GM.kick, 'taiko', { pitch: 50, decay: 2200, click: 0.5 }),
      drum('woodblock', GM.rim, 'woodblock-high', { pan: 0.3 }),
      drum('snare', GM.snare, 'snare-piccolo', { pitch: 260, decay: 220, ndecay: 260 }),
      drum('clash', GM.clap, 'crash-dark', { decay: 3500, pan: 0.2 }),
      drum('triangle mute', GM.closedHat, 'triangle-mute', { pan: 0.45 }),
      drum('triangle', GM.openHat, 'triangle', { pan: 0.45 }),
      drum('timpani low', GM.floorTom, 'timpani', { pitch: 87, pan: -0.35 }),
      drum('timpani', GM.lowTom, 'timpani', { pan: -0.2 }),
      drum('timpani high', GM.midTom, 'timpani', { pitch: 131, pan: -0.05 }),
      drum('cymbal', GM.crash, 'crash-dark', { pan: 0.3 }),
      drum('gong', GM.china, 'gong', { pan: -0.4 }),
      drum('tambourine', GM.tambourine, 'tambourine', { pan: 0.5 }),
      drum('bell', GM.rideBell, 'bell', { pan: 0.4 }),
      drum('glockenspiel', GM.triangleOpen, 'glockenspiel', { pan: 0.35 }),
    ],
  },
  {
    id: 'fx', name: 'FX & glitch', drums: [
      drum('kick', GM.kick, 'kick-fm'),
      drum('blip', GM.rim, 'blip'),
      drum('snare', GM.snare, 'bit-hit', { pitch: 330 }),
      drum('glitch', GM.clap, 'glitch'),
      drum('tick', GM.closedHat, 'hat-fm', { pan: HAT }),
      drum('riser', GM.openHat, 'noise-riser', { ndecay: 900, pan: HAT }),
      drum('zap', GM.lowTom, 'zap', { pan: -0.3 }),
      drum('laser', GM.midTom, 'laser', { pan: 0.3 }),
      drum('reverse', GM.crash, 'cym-reverse', { pan: CYM_L }),
      drum('drop', GM.highTom, 'drip', { pan: 0.4 }),
      drum('rise', GM.ride, 'rise', { pan: -0.4 }),
      drum('metal', GM.china, 'metal-hit', { pan: 0.2 }),
      drum('pop', GM.rideBell, 'vinyl-pop'),
      drum('sub drop', GM.crash2, 'sub-drop'),
      drum('impact', GM.splash, 'impact'),
    ],
  },
]

// effect params by name
const filter = (mode: number, cutoff: number, damping = 0.7071, gain = 0) => ({ type: SIMPLE_FILTER, params: { 0: mode, 1: cutoff, 2: damping, 3: gain } })
const eq = (bands: [number, number][], output = 0) => {
  const params: Record<string, number> = { 12: output }
  bands.forEach(([hz, db], i) => Object.assign(params, { [i * 3]: hz, [i * 3 + 1]: db, [i * 3 + 2]: 0.7071 }))
  return { type: EQ, params }
}
const reverb = (mix: number, size: number, damping: number, predelay = 0) => ({ type: REVERB, params: { 0: mix, 1: size, 2: damping, 3: predelay } })
const comp = (threshold: number, ratio: number, attack: number, release: number, makeup: number) =>
  ({ type: COMPRESSOR, params: { 0: threshold, 1: ratio, 2: attack, 3: release, 4: makeup } })
const tremolo = (rate: number, depth: number, shape: number, spread: number) => ({ type: TREMOLO, params: { 0: rate, 1: depth, 2: shape, 3: spread } })
type Dl = { mix: number; time: number; feedback: number; warble: number; drive: number; filter: number; cutoff: number; resonance: number }
const delay = (p: Dl) => ({ type: DELAY, params: { 0: p.mix, 1: p.time, 2: p.feedback, 3: p.warble, 4: p.drive, 5: p.filter, 6: p.cutoff, 7: p.resonance } })

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'tape-echo', name: 'Tape echo', devices: [delay({ mix: 0.3, time: 375, feedback: 0.45, warble: 0.35, drive: 0.3, filter: 0, cutoff: 3000, resonance: 0 })] },
  { id: 'dub-echo', name: 'Dub echo', devices: [delay({ mix: 0.35, time: 545, feedback: 0.78, warble: 0.2, drive: 0.5, filter: 2, cutoff: 1200, resonance: 0.3 })] },
  { id: 'big-room', name: 'Big room', devices: [reverb(0.35, 0.86, 0.4, 25)] },
  { id: 'small-room', name: 'Small room', devices: [reverb(0.18, 0.35, 0.6, 5)] },
  {
    id: 'lofi', name: 'Lofi', devices: [
      filter(0, 3800, 0.8),
      comp(-24, 5, 5, 140, 6),
      delay({ mix: 0.12, time: 90, feedback: 0.1, warble: 0.65, drive: 0.4, filter: 0, cutoff: 2500, resonance: 0 }),
    ],
  },
  {
    id: 'vocal-polish', name: 'Vocal polish', devices: [
      eq([[110, -4], [400, -1.5], [3000, 2], [10000, 3]]),
      comp(-20, 3, 8, 120, 4),
      reverb(0.15, 0.45, 0.5, 20),
    ],
  },
  { id: 'wide-tremolo', name: 'Wide tremolo', devices: [tremolo(3, 0.55, 0, 1), reverb(0.15, 0.5, 0.5, 10)] },
  { id: 'radio', name: 'Radio', devices: [filter(1, 450, 0.6), filter(0, 3200, 0.45), comp(-30, 8, 2, 80, 12)] },
  { id: 'glue', name: 'Bus glue', devices: [comp(-16, 2, 30, 200, 2)] },
  { id: 'warm-up', name: 'Warm up', devices: [eq([[120, 2], [500, 0], [3500, -1.5], [9000, -3]])] },
]

/** Clamp each param of `params` into its device's range (unknown ids are dropped). */
export function clampParams(type: number, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const def of DEVICES[type]?.params ?? []) {
    const v = params[String(def.id)]
    if (v != null) out[String(def.id)] = Math.min(def.max, Math.max(def.min, v))
  }
  return out
}

/** Set an existing instrument's params (and its label) to a preset. One undo step. */
export function applyInstrumentPreset(doc: Y.Doc, deviceId: string, preset: InstrumentPreset) {
  const type = devicesMap(doc).get(deviceId)?.get('type') as number | undefined
  if (type !== preset.type) return
  doc.transact(() => {
    for (const [id, v] of Object.entries(clampParams(type, preset.params))) setParam(doc, deviceId, Number(id), v)
    updateDevice(doc, deviceId, { name: preset.name })
  })
}

/** Add a preset instrument (full key range) to the end of a MIDI track's chain. Returns the device id. */
export const addInstrument = (doc: Y.Doc, trackId: string, preset: InstrumentPreset): string =>
  addDevice(doc, trackId, preset.type, { name: preset.name }, clampParams(preset.type, preset.params))

/**
 * Add a kit's drums to a MIDI track. A drum whose key the track already has a drum on takes over that drum (new name and
 * params) rather than stacking a second one on the same key. One undo step. Returns the drum ids, in the kit's order.
 */
export function addDrumKit(doc: Y.Doc, trackId: string, kit: DrumKit): string[] {
  const ids: string[] = []
  doc.transact(() => {
    const byKey = new Map(getDevices(doc).filter((d) => d.trackId === trackId && isDrum(d)).map((d) => [d.keyLo, d.id]))
    for (const d of kit.drums) {
      const params = clampParams(DRUM_SYNTH, d.params)
      const have = byKey.get(d.key)
      if (have && devicesMap(doc).get(have)?.get('type') === DRUM_SYNTH) {
        for (const [id, v] of Object.entries(params)) setParam(doc, have, Number(id), v)
        updateDevice(doc, have, { name: d.name })
        ids.push(have)
      } else {
        // another kind of drum on the key (an old lofi drum) gives way to the kit's
        if (have) deleteDevice(doc, have)
        const id = addDrum(doc, trackId, { key: d.key, name: d.name, params })
        byKey.set(d.key, id)
        ids.push(id)
      }
    }
  })
  return ids
}

/** Remove every drum (single-key instrument) on the track, then add the kit. One undo step. */
export function replaceDrumKit(doc: Y.Doc, trackId: string, kit: DrumKit): string[] {
  let ids: string[] = []
  doc.transact(() => {
    for (const d of getDevices(doc)) if (d.trackId === trackId && isDrum(d)) deleteDevice(doc, d.id)
    ids = addDrumKit(doc, trackId, kit)
  })
  return ids
}

/** Append a preset's effects, in order, to a track's chain (or the master's: `MASTER_TRACK`). One undo step. Returns the ids. */
export function addEffectPreset(doc: Y.Doc, trackId: string, preset: EffectPreset): string[] {
  const ids: string[] = []
  doc.transact(() => {
    for (const d of preset.devices) ids.push(addDevice(doc, trackId, d.type, {}, clampParams(d.type, d.params)))
  })
  return ids
}

export const instrumentPreset = (id: string) => INSTRUMENT_PRESETS.find((p) => p.id === id)
export const drumKit = (id: string) => DRUM_KITS.find((k) => k.id === id)
export const effectPreset = (id: string) => EFFECT_PRESETS.find((p) => p.id === id)
