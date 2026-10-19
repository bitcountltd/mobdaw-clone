//! The drum synth: one drum voice built from three layers, a pitched **body**, filtered **noise** and a **click**,
//! summed into drive, a tilt EQ, level and pan (docs/engine-api.md, "kind 9").
//!
//! # Body models
//! The body is one of five models; `character` and `timbre` are its two macro knobs, and mean something different in
//! each (the UI relabels them):
//!
//! | model | what it is | character | timbre |
//! |---|---|---|---|
//! | analog | a sine-core oscillator with a pitch sweep (808 / 909 kicks, toms, congas) | wave: sine → triangle → rounded square | overtone: a second, faster-decaying partial at 1.5–2.5× |
//! | fm | two-operator phase modulation (tablas, bells, zaps, FM snares) | ratio: modulator / carrier, 0.5–8 | index, which decays faster than the body |
//! | modal | eight resonant modes (Nord Drum, physical models) | material: membrane → harmonic → bar → bell | strike: mode weights, centre (dull) to edge (bright) |
//! | metal | six square waves at the 808 cymbal's ratios through a band-pass | spread: 2 squares (cowbell) → 6 → stretched | bright: the band-pass, 2–90× the pitch |
//! | string | Karplus–Strong plucked string / drum | damping of the loop filter | snare: sign-flip probability (Karplus–Strong drum) |
//!
//! The pitch sweeps from `pitch · 2^(bend/12)` down (or up) to `pitch`; the sweep falls to 10% after `bend time`.
//! Every layer decays exponentially to -60 dB over its own decay time.
//!
//! # Noise
//! White noise (xorshift) through an SVF (low / band / high), whose cutoff starts `sweep · 4` octaves off and settles
//! over half the noise decay. Shapes: `decay` (exponential), `gate` (held for the decay time, then a 4 ms fade: gated
//! snares), `clap` (three short bursts about 10 ms apart, then the tail: the 808 clap) and `swell` (rises over the decay
//! time, then cuts: reversed cymbals).
//!
//! # Click
//! An impulse plus a few ms of noise, band-limited around `click tone` (300 Hz thump to 19 kHz tick).
//!
//! # Velocity
//! `velocity` is the sensitivity: level goes as `vel^(2·sens)` (none, linear at 0.5, square law at 1), and soft hits
//! also bend less, click less and have darker noise, as struck drums do.
//!
//! # Voices, choke and key tracking
//! Monophonic like a drum machine voice: a new hit restarts it, and the old tail keeps sounding as a second strike
//! fading out over [`DECLICK`] samples. [`DrumSynth::choke`] fades it over [`CHOKE`] samples (the engine chokes the
//! other drums of a track that share a choke group). A tuned instrument (a device with a key range wider than one note)
//! passes the semitones from C4 to `note_on`, and the body and noise follow.
//!
//! # Determinism
//! All randomness is seeded from the note's start position (a timeline sample), so a hit renders the same samples on
//! every client and in every bounce.

use crate::fast::{exp2, tanh_rational};
use crate::smooth::Ramp;
use crate::svf::Svf;
use crate::util::flush_denormal;

/// Control-rate sub-block length (the same as the other instruments).
pub const SUB_BLOCK: usize = 32;
/// The old tail's fade-out when a hit retriggers, in samples.
pub const DECLICK: u32 = 64;
/// The fade when another drum of the choke group plays, in samples.
pub const CHOKE: u32 = 160;
/// Below this an envelope is treated as finished.
const SILENT: f32 = 1e-4;
/// ln(1000): 60 dB.
const LN_60DB: f32 = 6.907_755_3;
/// ln(10): 20 dB (the pitch sweep's "bend time").
const LN_20DB: f32 = 2.302_585;

pub const P_MODEL: u32 = 0;
pub const P_PITCH: u32 = 1;
pub const P_BEND: u32 = 2;
pub const P_BEND_TIME: u32 = 3;
pub const P_DECAY: u32 = 4;
pub const P_CHARACTER: u32 = 5;
pub const P_TIMBRE: u32 = 6;
pub const P_BODY: u32 = 7;
pub const P_NOISE: u32 = 8;
pub const P_NOISE_FILTER: u32 = 9;
pub const P_NOISE_FREQ: u32 = 10;
pub const P_NOISE_RES: u32 = 11;
pub const P_NOISE_DECAY: u32 = 12;
pub const P_NOISE_SHAPE: u32 = 13;
pub const P_SWEEP: u32 = 14;
pub const P_CLICK: u32 = 15;
pub const P_CLICK_TONE: u32 = 16;
pub const P_DRIVE: u32 = 17;
pub const P_COLOR: u32 = 18;
pub const P_VELOCITY: u32 = 19;
pub const P_PAN: u32 = 20;
pub const P_CHOKE: u32 = 21;
pub const P_LEVEL: u32 = 22;
pub const PARAM_COUNT: usize = 23;

pub const MODEL_ANALOG: u32 = 0;
pub const MODEL_FM: u32 = 1;
pub const MODEL_MODAL: u32 = 2;
pub const MODEL_METAL: u32 = 3;
pub const MODEL_STRING: u32 = 4;

pub const SHAPE_DECAY: u32 = 0;
pub const SHAPE_GATE: u32 = 1;
pub const SHAPE_CLAP: u32 = 2;
pub const SHAPE_SWELL: u32 = 3;

/// (min, max, default) per param id; the shared catalogue (shared/src/devices.ts) must match.
pub const RANGES: [(f32, f32, f32); PARAM_COUNT] = [
    (0.0, 4.0, 0.0),        // model
    (20.0, 8000.0, 55.0),   // pitch
    (-24.0, 48.0, 12.0),    // bend (semitones)
    (1.0, 1000.0, 45.0),    // bend time (ms)
    (5.0, 5000.0, 350.0),   // decay (ms)
    (0.0, 1.0, 0.2),        // character
    (0.0, 1.0, 0.3),        // timbre
    (0.0, 1.5, 1.0),        // body level
    (0.0, 1.5, 0.0),        // noise level
    (0.0, 2.0, 1.0),        // noise filter
    (40.0, 18000.0, 5000.0), // noise freq
    (0.0, 1.0, 0.2),        // noise res
    (2.0, 3000.0, 150.0),   // noise decay (ms)
    (0.0, 3.0, 0.0),        // noise shape
    (-1.0, 1.0, 0.0),       // sweep
    (0.0, 1.5, 0.3),        // click level
    (0.0, 1.0, 0.5),        // click tone
    (0.0, 1.0, 0.0),        // drive
    (-1.0, 1.0, 0.0),       // color
    (0.0, 1.0, 0.5),        // velocity sensitivity
    (-1.0, 1.0, 0.0),       // pan
    (0.0, 4.0, 0.0),        // choke group
    (0.0, 2.0, 0.8),        // level
];

const MODES: usize = 8;
/// Mode frequency ratios for the modal body's materials; `character` morphs across them.
const MATERIALS: [[f32; MODES]; 4] = [
    // circular membrane (Bessel zeros j_mn / j_01)
    [1.0, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501],
    // harmonic: a tuned membrane (tabla, timpani-ish) or a string
    [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
    // free-free bar (xylophone, woodblock, claves)
    [1.0, 2.756, 5.404, 8.933, 13.344, 18.638, 24.81, 31.87],
    // church bell partials from the hum (hum, prime, tierce, quint, nominal ...)
    [1.0, 2.0, 2.37, 3.01, 4.0, 5.03, 5.32, 6.02],
];
/// The 808 cymbal / hat's six square-wave frequencies (205.3, 304.4, 369.6, 522.7, 540, 800 Hz) over the lowest.
const METAL_RATIOS: [f32; 6] = [1.0, 1.4827, 1.8003, 2.5460, 2.6303, 3.8967];
const BUTTERWORTH: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// `sin(2 pi x)`, x in cycles: range-reduced 9th-order Taylor, absolute error under 4e-6 (fine for audio oscillators;
/// `fast::sin2pi` is not).
#[inline(always)]
pub fn sin_cycles(x: f32) -> f32 {
    let mut x = x - x.round();
    if x > 0.25 {
        x = 0.5 - x;
    } else if x < -0.25 {
        x = -0.5 - x;
    }
    let t = x * std::f32::consts::TAU;
    let t2 = t * t;
    t * (1.0 + t2 * (-1.0 / 6.0 + t2 * (1.0 / 120.0 + t2 * (-1.0 / 5040.0 + t2 * (1.0 / 362_880.0)))))
}

/// The per-sample factor that falls 60 dB in `ms`.
#[inline]
fn decay_k(ms: f32, sr: f32) -> f32 {
    (-LN_60DB / (ms.max(0.1) * 1e-3 * sr)).exp()
}

/// SVF damping for a resonance in 0..1 (Butterworth at 0, Q ~ 12 at 1).
#[inline]
fn res_damping(res: f32) -> f32 {
    BUTTERWORTH * (0.04f32 / BUTTERWORTH).powf(res.clamp(0.0, 1.0))
}

/// PolyBLEP residual for a naive step at phase `t` (cycles) with phase increment `dt`.
#[inline(always)]
fn blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// A band-limited square at phase `t`.
#[inline(always)]
fn square(t: f32, dt: f32) -> f32 {
    let naive = if t < 0.5 { 1.0 } else { -1.0 };
    let mut t2 = t + 0.5;
    if t2 >= 1.0 {
        t2 -= 1.0;
    }
    naive + blep(t, dt) - blep(t2, dt)
}

/// The current values of the params, as read once per control block.
#[derive(Clone, Copy)]
struct Controls {
    model: u32,
    pitch: f32,
    bend: f32,
    bend_ms: f32,
    decay_ms: f32,
    character: f32,
    timbre: f32,
    noise_filter: u32,
    noise_freq: f32,
    noise_res: f32,
    noise_ms: f32,
    noise_shape: u32,
    sweep: f32,
    click_tone: f32,
    velocity: f32,
}

/// One hit: every layer's state.
struct Strike {
    live: bool,
    /// Samples since the hit.
    t: u32,
    model: u32,
    rng: u32,
    // per-hit, from velocity and key
    amp: f32,
    bend_scale: f32,
    click_scale: f32,
    /// Noise cutoff factor (soft hits are darker).
    noise_dark: f32,
    /// Key tracking factor on the pitch (1 for a drum).
    key: f32,
    // body
    penv: f32,
    env: f32,
    env2: f32,
    ph: f32,
    ph2: f32,
    ienv: f32,
    modes: [(f32, f32); MODES],
    metal_ph: [f32; 6],
    metal_svf: Svf,
    ks: Vec<f32>,
    ks_w: usize,
    ks_prev: f32,
    /// The string's DC blocker (input and output memories).
    dc_x: f32,
    dc_y: f32,
    // noise
    nsvf: Svf,
    nenv: f32,
    senv: f32,
    /// The swell has peaked and is cutting off.
    swell_cut: bool,
    /// Clap burst start times (samples), and how many have started.
    bursts: [u32; 3],
    // click
    cenv: f32,
    c_lp: f32,
    c_hp: f32,
    c_imp: f32,
    // post
    tilt_lp: f32,
}

impl Strike {
    fn new(ks_len: usize) -> Self {
        Self {
            live: false,
            t: 0,
            model: 0,
            rng: 1,
            amp: 0.0,
            bend_scale: 1.0,
            click_scale: 1.0,
            noise_dark: 1.0,
            key: 1.0,
            penv: 0.0,
            env: 0.0,
            env2: 0.0,
            ph: 0.0,
            ph2: 0.0,
            ienv: 0.0,
            modes: [(0.0, 0.0); MODES],
            metal_ph: [0.0; 6],
            metal_svf: Svf::new(),
            ks: vec![0.0; ks_len],
            ks_w: 0,
            ks_prev: 0.0,
            dc_x: 0.0,
            dc_y: 0.0,
            nsvf: Svf::new(),
            nenv: 0.0,
            senv: 0.0,
            swell_cut: false,
            bursts: [0; 3],
            cenv: 0.0,
            c_lp: 0.0,
            c_hp: 0.0,
            c_imp: 0.0,
            tilt_lp: 0.0,
        }
    }

    /// xorshift32, mapped to -1..1.
    #[inline(always)]
    fn noise(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x as f32 * (2.0 / u32::MAX as f32) - 1.0
    }
}

/// A nonzero seed from a start sample (splitmix-style mixing, so near positions differ a lot).
fn seed_from(start: i64) -> u32 {
    let mut z = (start as u64).wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    ((z >> 32) as u32) | 1
}

/// The per-block coefficients shared by both strikes.
struct Block {
    sr: f32,
    inv_sr: f32,
    k_body: f32,
    k_body2: f32,
    k_bend: f32,
    k_index: f32,
    k_noise: f32,
    k_burst: f32,
    k_sweep: f32,
    k_click: f32,
    body_lvl: f32,
    noise_lvl: f32,
    click_lvl: f32,
    drive_pre: f32,
    drive_norm: f32,
    tilt_a: f32,
    tilt_lo: f32,
    tilt_hi: f32,
    noise_damp: f32,
    click_a: f32,
    click_hp_a: f32,
    click_gain: f32,
    noise_gain: f32,
    gate_len: u32,
    fade_k: f32,
}

pub struct DrumSynth {
    sample_rate: f32,
    smooth_samples: f64,
    /// Raw param values (jumping ones), by id.
    p: [f32; PARAM_COUNT],
    body: Ramp,
    noise: Ramp,
    click: Ramp,
    drive: Ramp,
    color: Ramp,
    pan: Ramp,
    level: Ramp,
    cur: Strike,
    /// The previous hit's tail, fading out; `fade_left` of `fade_len` samples remain.
    old: Strike,
    fade_left: u32,
    fade_len: u32,
}

impl DrumSynth {
    pub fn new(sample_rate: f32) -> Self {
        // the string's delay line holds one period of the lowest pitch (20 Hz) plus interpolation room
        let ks_len = ((sample_rate / RANGES[P_PITCH as usize].0) as usize + 4).next_power_of_two();
        let mut p = [0.0; PARAM_COUNT];
        for (v, r) in p.iter_mut().zip(RANGES.iter()) {
            *v = r.2;
        }
        let r = |id: u32| Ramp::new(RANGES[id as usize].2 as f64);
        Self {
            sample_rate,
            smooth_samples: sample_rate as f64 * 0.010,
            p,
            body: r(P_BODY),
            noise: r(P_NOISE),
            click: r(P_CLICK),
            drive: r(P_DRIVE),
            color: r(P_COLOR),
            pan: r(P_PAN),
            level: r(P_LEVEL),
            cur: Strike::new(ks_len),
            old: Strike::new(ks_len),
            fade_left: 0,
            fade_len: DECLICK,
        }
    }

    /// Set a parameter by contract id; values are clamped and non-finite ones ignored. The levels, drive, color and
    /// pan ramp over 10 ms; the rest are read per control block.
    pub fn set_param(&mut self, id: u32, value: f32) {
        self.set_param_smooth(id, value, self.smooth_samples);
    }

    /// Whether `id` glides (keep in step with `set_param_smooth`).
    pub fn is_smoothed(id: u32) -> bool {
        matches!(id, P_BODY | P_NOISE | P_CLICK | P_DRIVE | P_COLOR | P_PAN | P_LEVEL)
    }

    /// `set_param` with an explicit glide in samples (0 jumps; automation uses that).
    pub fn set_param_smooth(&mut self, id: u32, value: f32, s: f64) {
        if !value.is_finite() || id as usize >= PARAM_COUNT {
            return;
        }
        let (lo, hi, _) = RANGES[id as usize];
        let v = value.clamp(lo, hi);
        self.p[id as usize] = v;
        let ramp = match id {
            P_BODY => &mut self.body,
            P_NOISE => &mut self.noise,
            P_CLICK => &mut self.click,
            P_DRIVE => &mut self.drive,
            P_COLOR => &mut self.color,
            P_PAN => &mut self.pan,
            P_LEVEL => &mut self.level,
            _ => return,
        };
        ramp.set_target(v as f64, s);
    }

    /// The choke group (0: none, 1..4).
    pub fn choke_group(&self) -> u32 {
        self.p[P_CHOKE as usize].round() as u32
    }

    fn controls(&self) -> Controls {
        let p = &self.p;
        Controls {
            model: p[P_MODEL as usize].round() as u32,
            pitch: p[P_PITCH as usize],
            bend: p[P_BEND as usize],
            bend_ms: p[P_BEND_TIME as usize],
            decay_ms: p[P_DECAY as usize],
            character: p[P_CHARACTER as usize],
            timbre: p[P_TIMBRE as usize],
            noise_filter: p[P_NOISE_FILTER as usize].round() as u32,
            noise_freq: p[P_NOISE_FREQ as usize],
            noise_res: p[P_NOISE_RES as usize],
            noise_ms: p[P_NOISE_DECAY as usize],
            noise_shape: p[P_NOISE_SHAPE as usize].round() as u32,
            sweep: p[P_SWEEP as usize],
            click_tone: p[P_CLICK_TONE as usize],
            velocity: p[P_VELOCITY as usize],
        }
    }

    /// Hit the drum. `semis` is the key tracking offset from C4 (0 for a drum on one key); `start` is the note's start
    /// on the caller's clock (timeline samples), which seeds the noise. A hit still ringing fades out over [`DECLICK`].
    pub fn note_on(&mut self, velocity: f32, semis: f32, start: i64) {
        self.fade_current(DECLICK);
        let c = self.controls();
        let sr = self.sample_rate;
        let vel = velocity.clamp(0.0, 1.0);
        let sens = c.velocity;
        let s = &mut self.cur;
        s.live = true;
        s.t = 0;
        s.model = c.model;
        s.rng = seed_from(start);
        s.amp = if sens <= 0.0 { 1.0 } else { vel.max(1e-3).powf(2.0 * sens) };
        let soft = sens * (1.0 - vel);
        s.bend_scale = 1.0 - 0.5 * soft;
        s.click_scale = 1.0 - 0.7 * soft;
        s.noise_dark = exp2(-soft);
        s.key = exp2(semis.clamp(-96.0, 96.0) / 12.0);
        s.penv = 1.0;
        s.env = 1.0;
        s.env2 = 1.0;
        s.ienv = 1.0;
        s.ph = 0.0;
        s.ph2 = 0.0;
        s.metal_svf.reset();
        s.nsvf.reset();
        s.senv = 1.0;
        s.swell_cut = false;
        s.cenv = 1.0;
        s.c_lp = 0.0;
        s.c_hp = 0.0;
        s.c_imp = 1.0;
        s.tilt_lp = 0.0;
        // clap: three bursts roughly 10 ms apart (a little uneven, as the 808's are), then the tail
        let ms = sr * 1e-3;
        let j1 = s.noise() * 1.2;
        let j2 = s.noise() * 1.2;
        s.bursts = [0, ((10.0 + j1) * ms) as u32, ((20.5 + j2) * ms) as u32];
        s.nenv = if c.noise_shape == SHAPE_SWELL { 1e-3 } else { 1.0 };
        // metal: the squares start at seeded phases, so they don't all line up in a click
        for i in 0..6 {
            let n = s.noise();
            s.metal_ph[i] = n * 0.5 + 0.5;
        }
        // modal: each mode starts at its weight (see `mode_weights`)
        let w = mode_weights(c.character, c.timbre);
        for (m, &a) in s.modes.iter_mut().zip(w.iter()) {
            *m = (a, 0.0);
        }
        // string: one period of noise, smoothed more for low `timbre` (a softer pluck); mean removed so it doesn't thump
        if c.model == MODEL_STRING {
            let f = (c.pitch * s.key * exp2(c.bend * s.bend_scale / 12.0)).clamp(20.0, 0.45 * sr);
            let len = ((sr / f) as usize).clamp(2, s.ks.len() - 2);
            let smooth = 0.6 * (1.0 - c.timbre);
            let mut lp = 0.0;
            let mut sum = 0.0;
            for i in 0..len {
                let n = s.noise();
                lp += (n - lp) * (1.0 - smooth);
                s.ks[i] = lp;
                sum += lp;
            }
            let mean = sum / len as f32;
            let mut peak = 1e-6f32;
            for v in &mut s.ks[..len] {
                *v -= mean;
                peak = peak.max(v.abs());
            }
            for v in &mut s.ks[..len] {
                *v /= peak;
            }
            for v in &mut s.ks[len..] {
                *v = 0.0;
            }
            // the read head starts one period behind the write head
            s.ks_w = len;
            s.ks_prev = 0.0;
            s.dc_x = 0.0;
            s.dc_y = 0.0;
        }
    }

    /// Cut this drum (another drum of its choke group played): fade over [`CHOKE`] samples.
    pub fn choke(&mut self) {
        self.fade_current(CHOKE);
    }

    /// Fade out whatever is ringing (transport stop / seek).
    pub fn release_all(&mut self) {
        self.fade_current(DECLICK);
    }

    fn fade_current(&mut self, len: u32) {
        if self.cur.live {
            std::mem::swap(&mut self.cur, &mut self.old);
            self.fade_left = len;
            self.fade_len = len;
        }
        self.cur.live = false;
    }

    /// Hard stop: silence at once (used when the device is bypassed).
    pub fn reset(&mut self) {
        self.cur.live = false;
        self.old.live = false;
        self.fade_left = 0;
    }

    pub fn is_active(&self) -> bool {
        self.cur.live || (self.old.live && self.fade_left > 0)
    }

    pub fn is_ramping(&self) -> bool {
        [&self.body, &self.noise, &self.click, &self.drive, &self.color, &self.pan, &self.level].iter().any(|r| r.is_moving())
    }

    /// Add the stereo output into `l` and `r` (same length).
    pub fn render_add(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (l, r) in l.chunks_mut(SUB_BLOCK).zip(r.chunks_mut(SUB_BLOCK)) {
            self.render_block(l, r);
        }
    }

    fn render_block(&mut self, l: &mut [f32], r: &mut [f32]) {
        let len = l.len();
        let c = self.controls();
        let sr = self.sample_rate;
        let body = self.body.value() as f32;
        let noise = self.noise.value() as f32;
        let click = self.click.value() as f32;
        let drive = self.drive.value() as f32;
        let color = self.color.value() as f32;
        let pan0 = self.pan.value() as f32;
        let lv0 = self.level.value() as f32;
        self.body.advance(len);
        self.noise.advance(len);
        self.click.advance(len);
        self.drive.advance(len);
        self.color.advance(len);
        let pan1 = self.pan.advance(len) as f32;
        let lv1 = self.level.advance(len) as f32;

        if !self.is_active() {
            return;
        }
        let drive_pre = 1.0 + 9.0 * drive * drive;
        let k_body = decay_k(c.decay_ms, sr);
        // the click: 60 dB over 2 ms (bright) to 8 ms (thump)
        let click_ms = 2.0 + 6.0 * (1.0 - c.click_tone);
        let click_fc = 300.0 * exp2(c.click_tone * 6.0);
        let b = Block {
            sr,
            inv_sr: 1.0 / sr,
            k_body,
            k_body2: k_body * k_body,
            k_bend: (-LN_20DB / (c.bend_ms * 1e-3 * sr)).exp(),
            k_index: decay_k((c.decay_ms * 0.3).max(5.0), sr),
            k_noise: decay_k(c.noise_ms, sr),
            k_burst: decay_k(9.0, sr),
            k_sweep: decay_k((c.noise_ms * 0.5).max(3.0), sr),
            k_click: decay_k(click_ms, sr),
            body_lvl: body,
            noise_lvl: noise,
            click_lvl: click,
            drive_pre,
            drive_norm: if drive > 0.0 { 1.0 / tanh_rational(drive_pre) } else { 1.0 },
            tilt_a: 1.0 - (-std::f32::consts::TAU * 700.0 / sr).exp(),
            tilt_lo: exp2(-0.5 * color),
            tilt_hi: exp2(1.0 * color),
            noise_damp: res_damping(c.noise_res),
            click_a: 1.0 - (-std::f32::consts::TAU * click_fc.min(0.45 * sr) / sr).exp(),
            click_hp_a: 1.0 - (-std::f32::consts::TAU * (click_fc * 0.25) / sr).exp(),
            // a narrow low-pass passes less of the noise: make up some of it
            click_gain: 1.2 * (19_200.0 / click_fc).powf(0.35),
            noise_gain: 1.0,
            gate_len: (c.noise_ms * 1e-3 * sr) as u32,
            fade_k: decay_k(4.0, sr),
        };
        let mut y = [0.0f32; SUB_BLOCK];
        let y = &mut y[..len];
        if self.cur.live {
            render_strike(&mut self.cur, &c, &b, y, None);
        }
        if self.old.live && self.fade_left > 0 {
            render_strike(&mut self.old, &c, &b, y, Some((self.fade_left, self.fade_len)));
            self.fade_left = self.fade_left.saturating_sub(len as u32);
            if self.fade_left == 0 {
                self.old.live = false;
            }
        }
        // level and constant-power pan, interpolated across the block
        let n = len as f32;
        for (i, ((l, r), v)) in l.iter_mut().zip(r.iter_mut()).zip(y.iter()).enumerate() {
            let f = (i + 1) as f32 / n;
            let g = lv0 + (lv1 - lv0) * f;
            let pan = pan0 + (pan1 - pan0) * f;
            // pan law: sin/cos at 0..1 quarter turns (-3 dB in the centre)
            let a = (pan + 1.0) * 0.125;
            let gl = sin_cycles(0.25 - a) * std::f32::consts::SQRT_2;
            let gr = sin_cycles(a) * std::f32::consts::SQRT_2;
            *l += v * g * gl;
            *r += v * g * gr;
        }
    }
}

/// The modal body's mode weights for a material and strike: duller (centre) strikes weight the low modes, bright
/// (edge) strikes the upper ones. They sum to about 1.
fn mode_weights(_character: f32, strike: f32) -> [f32; MODES] {
    let tilt = 2.2 - 2.6 * strike; // k^-tilt
    let mut w = [0.0; MODES];
    let mut sum = 0.0;
    for (k, v) in w.iter_mut().enumerate() {
        *v = ((k + 1) as f32).powf(-tilt);
        sum += *v;
    }
    for v in &mut w {
        *v /= sum.max(1e-6);
    }
    w
}

/// The modal ratios for `character` (0 membrane, 1/3 harmonic, 2/3 bar, 1 bell), interpolated between materials.
fn mode_ratios(character: f32) -> [f32; MODES] {
    let x = character.clamp(0.0, 1.0) * 3.0;
    let i = (x as usize).min(2);
    let f = x - i as f32;
    let mut out = [0.0; MODES];
    for k in 0..MODES {
        let (a, b) = (MATERIALS[i][k], MATERIALS[i + 1][k]);
        out[k] = a * (b / a).powf(f);
    }
    out
}

/// Render one strike into `y` (added). `fade`: (samples left, fade length) for a tail being faded out.
fn render_strike(s: &mut Strike, c: &Controls, b: &Block, y: &mut [f32], fade: Option<(u32, u32)>) {
    let sr = b.sr;
    let nyq = 0.45 * sr;
    let base = c.pitch * s.key;
    let bend_oct = c.bend * s.bend_scale / 12.0;
    // a layer at level 0 is finished, so a hit with nothing audible left goes to sleep
    if b.body_lvl <= 0.0 {
        s.env = 0.0;
    }
    if b.noise_lvl <= 0.0 {
        s.nenv = 0.0;
    }
    if b.click_lvl <= 0.0 {
        s.cenv = 0.0;
        s.c_imp = 0.0;
    }
    let body_on = s.env > SILENT;
    let noise_on = s.nenv > SILENT || (c.noise_shape == SHAPE_CLAP && s.t < s.bursts[2]) || (c.noise_shape == SHAPE_SWELL && !s.swell_cut && s.nenv > 0.0);
    let click_on = s.cenv > SILENT || s.c_imp != 0.0;
    if !body_on && !noise_on && !click_on && s.c_lp.abs() < SILENT {
        s.live = false;
        return;
    }

    // --- per-block body setup
    let model = s.model;
    // the frequency at the block start drives the modal / metal coefficients (the sweep is smooth across 32 samples)
    let f_now = (base * exp2(bend_oct * s.penv)).clamp(10.0, nyq);
    let mut modal = [(0.0f32, 0.0f32); MODES];
    if body_on && model == MODEL_MODAL {
        let ratios = mode_ratios(c.character);
        for k in 0..MODES {
            let f = f_now * ratios[k];
            if f >= nyq {
                modal[k] = (0.0, 0.0);
                s.modes[k] = (0.0, 0.0);
                continue;
            }
            // higher modes ring shorter
            let decay = c.decay_ms * ratios[k].powf(-0.6);
            let rad = decay_k(decay, sr);
            let w = std::f32::consts::TAU * f / sr;
            modal[k] = (rad * w.cos(), rad * w.sin());
        }
    }
    let mut metal_inc = [0.0f32; 6];
    let mut metal_w = [0.0f32; 6];
    if body_on && model == MODEL_METAL {
        // character: 0..0.2 fades in the upper four squares (2 = the 808 cowbell), then stretches the ratios
        let two = (c.character / 0.2).min(1.0);
        // the 808's own ratios at 0.6; squeezed below, stretched above
        let stretch = if c.character <= 0.2 { 1.0 } else { 0.7 + (c.character - 0.2) / 0.8 * 0.6 };
        for k in 0..6 {
            let ratio = if k < 2 { METAL_RATIOS[k] } else { METAL_RATIOS[k].powf(stretch) };
            metal_inc[k] = (f_now * ratio / sr).min(0.45);
            metal_w[k] = if k < 2 { 1.0 } else { two };
        }
        let center = (f_now * exp2(1.0 + c.timbre * 5.5)).min(nyq);
        s.metal_svf.set_hz(center, 0.55, sr);
    }
    if noise_on {
        let f = (c.noise_freq * s.noise_dark * s.key.sqrt() * exp2(c.sweep * 4.0 * s.senv)).clamp(20.0, nyq);
        s.nsvf.set_hz(f, b.noise_damp, sr);
    }
    let noise_norm = match c.noise_filter {
        // a band-pass passes a slice of the noise: lift it by sqrt(1/damping) so narrow ones stay audible
        1 => b.noise_damp.sqrt() * 1.6,
        _ => 1.0,
    };
    // string: the loop filter and the gain per pass that gives 60 dB over the decay
    let ks_mask = s.ks.len() - 1;
    let ks_damp = 0.5 * c.character;
    let flip = (c.timbre * 0.5 * u32::MAX as f32) as u32;
    let ks_g = b.k_body.powf(sr / f_now);

    let fm_ratio = 0.5 * exp2(c.character * 4.0);
    let fm_index = c.timbre * c.timbre * 9.0;
    let wave = c.character;
    let ot_ratio = 1.5 + c.timbre;
    let ot_level = (c.timbre * 2.0).min(1.0) * 0.6;

    for (i, out) in y.iter_mut().enumerate() {
        let mut body = 0.0;
        if body_on {
            let f = (base * exp2(bend_oct * s.penv)).clamp(10.0, nyq);
            let inc = f * b.inv_sr;
            match model {
                MODEL_ANALOG => {
                    s.ph += inc;
                    s.ph -= s.ph.floor();
                    let sine = sin_cycles(s.ph);
                    let v = if wave <= 0.5 {
                        // triangle starting at 0, rising, like the sine
                        let t = s.ph;
                        let tri = if t < 0.25 { 4.0 * t } else if t < 0.75 { 2.0 - 4.0 * t } else { 4.0 * t - 4.0 };
                        sine + (tri - sine) * (wave * 2.0)
                    } else {
                        let t = s.ph;
                        let tri = if t < 0.25 { 4.0 * t } else if t < 0.75 { 2.0 - 4.0 * t } else { 4.0 * t - 4.0 };
                        let sq = tanh_rational(3.0 * sine);
                        tri + (sq - tri) * ((wave - 0.5) * 2.0)
                    };
                    let mut v = v * s.env;
                    if ot_level > 0.0 {
                        s.ph2 += (inc * ot_ratio).min(0.45);
                        s.ph2 -= s.ph2.floor();
                        v += sin_cycles(s.ph2) * ot_level * s.env2;
                    }
                    body = v;
                }
                MODEL_FM => {
                    s.ph += inc;
                    s.ph -= s.ph.floor();
                    s.ph2 += (inc * fm_ratio).min(0.49);
                    s.ph2 -= s.ph2.floor();
                    let m = sin_cycles(s.ph2) * fm_index * s.ienv * (1.0 / std::f32::consts::TAU);
                    body = sin_cycles(s.ph + m) * s.env;
                    s.ienv *= b.k_index;
                }
                MODEL_MODAL => {
                    let mut v = 0.0;
                    for (z, r) in s.modes.iter_mut().zip(modal.iter()) {
                        let (re, im) = *z;
                        *z = (re * r.0 - im * r.1, re * r.1 + im * r.0);
                        v += z.1;
                    }
                    body = v * 1.6;
                }
                MODEL_METAL => {
                    let mut v = 0.0;
                    for k in 0..6 {
                        let dt = metal_inc[k];
                        let mut t = s.metal_ph[k] + dt;
                        if t >= 1.0 {
                            t -= 1.0;
                        }
                        s.metal_ph[k] = t;
                        v += square(t, dt) * metal_w[k];
                    }
                    let f = s.metal_svf.process(v * 0.3);
                    body = (f.bp() * 1.2 + f.hp() * 0.5) * s.env;
                }
                _ => {
                    // string: read one (fractional) period back, through the two-point loop filter
                    let len = (sr / f).clamp(2.0, (s.ks.len() - 3) as f32);
                    let pos = s.ks_w as f32 - len;
                    let pos = if pos < 0.0 { pos + s.ks.len() as f32 } else { pos };
                    let i0 = pos as usize;
                    let fr = pos - i0 as f32;
                    let a = s.ks[i0 & ks_mask];
                    let bb = s.ks[(i0 + 1) & ks_mask];
                    let x = a + (bb - a) * fr;
                    let filt = x * (1.0 - ks_damp) + s.ks_prev * ks_damp;
                    s.ks_prev = x;
                    let mut w = filt * ks_g;
                    if flip > 0 {
                        let n = s.noise();
                        if ((n * 0.5 + 0.5) * u32::MAX as f32) < flip as f32 {
                            w = -w;
                        }
                    }
                    s.ks[s.ks_w & ks_mask] = flush_denormal(w);
                    s.ks_w = (s.ks_w + 1) & ks_mask;
                    // the loop keeps any DC it gets (interpolation while the pitch bends): block it, ~15 Hz
                    s.dc_y = flush_denormal(x - s.dc_x + 0.998 * s.dc_y);
                    s.dc_x = x;
                    body = s.dc_y;
                }
            }
            s.penv *= b.k_bend;
            s.env *= b.k_body;
            s.env2 *= b.k_body2;
        }

        let mut nz = 0.0;
        if noise_on {
            let raw = s.noise();
            let f = s.nsvf.process(raw);
            let v = match c.noise_filter {
                0 => f.lp(),
                1 => f.bp() * b.noise_damp * 2.0,
                _ => f.hp(),
            } * noise_norm;
            // the envelope
            let e = match c.noise_shape {
                SHAPE_GATE => {
                    if s.t >= b.gate_len {
                        s.nenv *= b.fade_k;
                    }
                    s.nenv
                }
                SHAPE_CLAP => {
                    if s.t == s.bursts[1] || s.t == s.bursts[2] {
                        s.nenv = 1.0;
                    }
                    let k = if s.t < s.bursts[2] { b.k_burst } else { b.k_noise };
                    s.nenv *= k;
                    s.nenv
                }
                SHAPE_SWELL => {
                    // rises 60 dB over the decay, then cuts
                    if s.swell_cut {
                        s.nenv *= b.fade_k;
                    } else {
                        s.nenv /= b.k_noise;
                        if s.nenv >= 1.0 {
                            s.nenv = 1.0;
                            s.swell_cut = true;
                        }
                    }
                    s.nenv
                }
                _ => {
                    s.nenv *= b.k_noise;
                    s.nenv
                }
            };
            s.senv *= b.k_sweep;
            nz = v * e * b.noise_gain;
        }

        let mut ck = 0.0;
        if click_on {
            let n = s.noise();
            let x = n * s.cenv + s.c_imp * 0.7;
            s.c_imp = 0.0;
            s.c_lp += (x - s.c_lp) * b.click_a;
            s.c_hp += (s.c_lp - s.c_hp) * b.click_hp_a;
            ck = (s.c_lp - s.c_hp) * b.click_gain;
            s.cenv *= b.k_click;
            s.c_lp = flush_denormal(s.c_lp);
            s.c_hp = flush_denormal(s.c_hp);
        }

        let mut v = body * b.body_lvl + nz * b.noise_lvl + ck * b.click_lvl * s.click_scale;
        if b.drive_pre > 1.0 {
            v = tanh_rational(v * b.drive_pre) * b.drive_norm;
        }
        // tilt: a one-pole split at 700 Hz, lows and highs weighted against each other
        s.tilt_lp += (v - s.tilt_lp) * b.tilt_a;
        s.tilt_lp = flush_denormal(s.tilt_lp);
        v = s.tilt_lp * b.tilt_lo + (v - s.tilt_lp) * b.tilt_hi;
        v *= s.amp;
        if let Some((left, flen)) = fade {
            v *= left.saturating_sub(i as u32) as f32 / flen as f32;
        }
        *out += v;
        s.t = s.t.saturating_add(1);
    }
    s.env = flush_denormal(s.env);
    s.env2 = flush_denormal(s.env2);
    s.penv = flush_denormal(s.penv);
    s.ienv = flush_denormal(s.ienv);
    s.nenv = flush_denormal(s.nenv);
    s.cenv = flush_denormal(s.cenv);
    if model == MODEL_MODAL {
        for z in &mut s.modes {
            *z = (flush_denormal(z.0), flush_denormal(z.1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;

    fn synth(params: &[(u32, f32)]) -> DrumSynth {
        let mut d = DrumSynth::new(SR);
        for &(id, v) in params {
            d.set_param_smooth(id, v, 0.0);
        }
        d
    }

    fn hit(d: &mut DrumSynth, vel: f32, start: i64, n: usize) -> Vec<f32> {
        d.note_on(vel, 0.0, start);
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        d.render_add(&mut l, &mut r);
        l
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    /// The frequency from upward zero crossings in a stretch.
    fn freq(x: &[f32]) -> f32 {
        let ups: Vec<usize> = (1..x.len()).filter(|&i| x[i - 1] <= 0.0 && x[i] > 0.0).collect();
        if ups.len() < 2 {
            return 0.0;
        }
        (ups.len() - 1) as f32 * SR / (ups[ups.len() - 1] - ups[0]) as f32
    }

    /// The frequency from the autocorrelation peak (for waveforms with many crossings per period).
    fn freq_ac(x: &[f32], lo_hz: f32, hi_hz: f32) -> f32 {
        let (min_lag, max_lag) = ((SR / hi_hz) as usize, (SR / lo_hz) as usize);
        let n = x.len() - max_lag;
        let ac = |lag: usize| (0..n).map(|i| x[i] * x[i + lag]).sum::<f32>();
        let best = (min_lag..=max_lag).max_by(|&a, &b| ac(a).partial_cmp(&ac(b)).unwrap()).unwrap();
        SR / best as f32
    }

    #[test]
    fn sin_cycles_is_accurate() {
        for i in 0..10_000 {
            let x = i as f32 / 997.0 - 5.0;
            let e = (sin_cycles(x) - (x as f64 * std::f64::consts::TAU).sin() as f32).abs();
            assert!(e < 1e-5, "{x}: {e}");
        }
    }

    #[test]
    fn every_model_sounds_finite_and_bounded_then_sleeps() {
        for model in 0..5 {
            for shape in 0..4 {
                let mut d = synth(&[(P_MODEL, model as f32), (P_NOISE, 0.8), (P_NOISE_SHAPE, shape as f32), (P_DECAY, 300.0), (P_NOISE_DECAY, 200.0), (P_PITCH, 180.0)]);
                let out = hit(&mut d, 1.0, 99, 48_000);
                assert!(out.iter().all(|v| v.is_finite()), "model {model} shape {shape}");
                let pk = out.iter().fold(0.0f32, |a, v| a.max(v.abs()));
                assert!(pk > 0.05 && pk < 4.0, "model {model} shape {shape}: peak {pk}");
                assert!(!d.is_active(), "model {model} shape {shape} still active after 1 s");
            }
        }
    }

    #[test]
    fn same_start_renders_the_same_samples_and_other_starts_differ() {
        let p = [(P_MODEL, 3.0), (P_NOISE, 0.5)];
        let a = hit(&mut synth(&p), 1.0, 12_345, 4000);
        let b = hit(&mut synth(&p), 1.0, 12_345, 4000);
        let c = hit(&mut synth(&p), 1.0, 12_346, 4000);
        assert_eq!(a, b);
        assert!(a != c);
    }

    #[test]
    fn analog_body_lands_on_its_pitch_after_the_bend() {
        let mut d = synth(&[(P_PITCH, 60.0), (P_BEND, 24.0), (P_BEND_TIME, 30.0), (P_DECAY, 2000.0), (P_CLICK, 0.0), (P_CHARACTER, 0.0), (P_TIMBRE, 0.0)]);
        let out = hit(&mut d, 1.0, 0, 48_000);
        let early = freq(&out[0..1200]);
        let late = freq(&out[24_000..48_000]);
        assert!(early > 100.0, "early {early}");
        assert!((late - 60.0).abs() < 1.0, "late {late}");
    }

    #[test]
    fn modal_and_string_land_on_their_pitch() {
        let mut d = synth(&[(P_MODEL, 2.0), (P_PITCH, 220.0), (P_BEND, 0.0), (P_DECAY, 2000.0), (P_CLICK, 0.0), (P_TIMBRE, 0.0)]);
        let out = hit(&mut d, 1.0, 0, 24_000);
        assert!((freq(&out[4800..24_000]) - 220.0).abs() < 4.0, "modal {}", freq(&out[4800..24_000]));
        let mut d = synth(&[(P_MODEL, 4.0), (P_PITCH, 220.0), (P_BEND, 0.0), (P_DECAY, 2000.0), (P_CLICK, 0.0), (P_CHARACTER, 1.0), (P_TIMBRE, 0.0)]);
        let out = hit(&mut d, 1.0, 0, 24_000);
        let f = freq_ac(&out[4800..14_400], 100.0, 1000.0);
        assert!((f - 220.0).abs() < 4.0, "string {f}");
    }

    #[test]
    fn decays_about_60_db_over_the_decay_time() {
        let mut d = synth(&[(P_PITCH, 200.0), (P_BEND, 0.0), (P_DECAY, 200.0), (P_CLICK, 0.0), (P_CHARACTER, 0.0), (P_TIMBRE, 0.0)]);
        let out = hit(&mut d, 1.0, 0, 24_000);
        let early = rms(&out[240..720]);
        let at = rms(&out[9600 - 240..9600 + 240]);
        let db = 20.0 * (at / early).log10();
        assert!(db < -50.0 && db > -66.0, "{db} dB");
    }

    #[test]
    fn velocity_sensitivity_shapes_the_level() {
        let p = |s: f32| synth(&[(P_VELOCITY, s), (P_CLICK, 0.0)]);
        let full = rms(&hit(&mut p(0.5), 1.0, 7, 4000));
        let half = rms(&hit(&mut p(0.5), 0.5, 7, 4000));
        assert!((half / full - 0.5).abs() < 0.08, "{}", half / full);
        let flat = rms(&hit(&mut p(0.0), 0.3, 7, 4000));
        assert!((flat / full - 1.0).abs() < 0.01);
    }

    #[test]
    fn a_retrigger_and_a_choke_fade_without_a_jump() {
        let mut d = synth(&[(P_MODEL, 3.0), (P_DECAY, 800.0), (P_LEVEL, 1.0), (P_CLICK, 0.0)]);
        let mut l = vec![0.0; 6000];
        let mut r = vec![0.0; 6000];
        d.note_on(1.0, 0.0, 0);
        d.render_add(&mut l[..2000], &mut r[..2000]);
        d.choke();
        d.render_add(&mut l[2000..4000], &mut r[2000..4000]);
        assert!(l[2000 + CHOKE as usize + 32..4000].iter().all(|&v| v == 0.0));
        let max_step = l[1990..2400].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        let own = l[100..1990].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        assert!(max_step <= own * 1.05 + 1e-6, "{max_step} vs {own}");
        assert!(!d.is_active());
    }

    #[test]
    fn key_tracking_moves_the_pitch() {
        let p = [(P_PITCH, 220.0), (P_BEND, 0.0), (P_DECAY, 2000.0), (P_CLICK, 0.0), (P_TIMBRE, 0.0), (P_CHARACTER, 0.0)];
        let mut d = synth(&p);
        d.note_on(1.0, 12.0, 0);
        let mut l = vec![0.0; 9600];
        let mut r = vec![0.0; 9600];
        d.render_add(&mut l, &mut r);
        assert!((freq(&l[2400..]) - 440.0).abs() < 3.0, "{}", freq(&l[2400..]));
    }

    #[test]
    fn pan_moves_the_hit_between_the_channels() {
        let mut d = synth(&[(P_PAN, -1.0)]);
        d.note_on(1.0, 0.0, 0);
        let mut l = vec![0.0; 2000];
        let mut r = vec![0.0; 2000];
        d.render_add(&mut l, &mut r);
        assert!(rms(&l) > 0.01);
        assert!(rms(&r) < rms(&l) * 1e-3);
    }

    #[test]
    fn random_params_never_blow_up() {
        let mut rng = 12345u32;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng as f32 / u32::MAX as f32
        };
        for case in 0..200 {
            let mut d = DrumSynth::new(SR);
            for (id, (lo, hi, _)) in RANGES.iter().enumerate() {
                let v = lo + (hi - lo) * next();
                d.set_param_smooth(id as u32, v, 0.0);
            }
            d.set_param_smooth(P_DECAY, 5.0 + 500.0 * next(), 0.0);
            d.set_param_smooth(P_NOISE_DECAY, 2.0 + 500.0 * next(), 0.0);
            let out = hit(&mut d, next(), case, 48_000);
            let pk = out.iter().fold(0.0f32, |a, v| a.max(v.abs()));
            assert!(out.iter().all(|v| v.is_finite()) && pk < 8.0, "case {case}: peak {pk}");
        }
    }
}
