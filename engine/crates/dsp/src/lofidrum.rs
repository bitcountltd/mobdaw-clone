//! The lofi drum: white noise -> SVF low-pass -> decay envelope -> gain, a one-shot
//! (docs/engine-api.md, "kind 7").
//!
//! # Voice
//! Per sample: `out = lp(noise) * env * velocity * gain`. The envelope is exponential, `env`
//! starts at 1 and is multiplied by a constant each sample so that it has fallen 60 dB after
//! `decay` ms. Pitch and note length are ignored: a hit always rings out.
//!
//! # Monophonic
//! A new hit restarts the envelope. The old tail is not cut: it keeps sounding as a second
//! strike (its own noise and filter state) and fades out linearly over [`DECLICK`] samples, so
//! a retrigger never clicks. At most two strikes sound at once, and nothing allocates.
//!
//! # Determinism
//! The noise is a xorshift generator seeded from the note's start position (a timeline
//! sample), so the same hit at the same place renders the same samples on every client and in
//! every bounce.

use crate::smooth::Ramp;
use crate::svf::Svf;
use crate::util::flush_denormal;

/// Control-rate sub-block length (the same as the other instruments).
pub const SUB_BLOCK: usize = 32;
/// The old tail's fade-out when a hit retriggers, in samples.
pub const DECLICK: u32 = 64;
/// Below this the envelope is treated as finished.
const SILENT: f32 = 1e-4;

pub const P_CUTOFF: u32 = 0;
pub const P_RESONANCE: u32 = 1;
pub const P_DECAY_MS: u32 = 2;
pub const P_GAIN: u32 = 3;

pub const CUTOFF_MIN: f32 = 20.0;
pub const CUTOFF_MAX: f32 = 20000.0;
pub const DECAY_MIN_MS: f32 = 1.0;
pub const DECAY_MAX_MS: f32 = 2000.0;
const DAMPING_BUTTERWORTH: f32 = std::f32::consts::FRAC_1_SQRT_2;
/// Damping at resonance 1 (Q = 12.5): the filter rings.
const DAMPING_RINGING: f32 = 0.04;

/// One strike: a noise stream through its own filter, under its own envelope.
#[derive(Clone)]
struct Strike {
    svf: Svf,
    rng: u32,
    env: f32,
    velocity: f32,
}

impl Strike {
    fn silent() -> Self {
        Self { svf: Svf::new(), rng: 1, env: 0.0, velocity: 0.0 }
    }

    fn live(&self) -> bool {
        self.env > SILENT
    }

    /// xorshift32, mapped to -1..1.
    #[inline]
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

pub struct LofiDrum {
    sample_rate: f32,
    smooth_samples: f64,
    cutoff_log2: Ramp,
    resonance: Ramp,
    gain: Ramp,
    decay_ms: f32,
    cur: Strike,
    /// The previous hit's tail, fading out; `fade_left` samples remain.
    old: Strike,
    fade_left: u32,
}

impl LofiDrum {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            smooth_samples: sample_rate as f64 * 0.010,
            cutoff_log2: Ramp::new(2000f64.log2()),
            resonance: Ramp::new(0.3),
            gain: Ramp::new(0.5),
            decay_ms: 60.0,
            cur: Strike::silent(),
            old: Strike::silent(),
            fade_left: 0,
        }
    }

    /// Set a parameter by contract id; values are clamped and non-finite ones ignored. Cutoff
    /// (in the log2 domain), resonance and gain ramp over 10 ms; decay is read per block.
    pub fn set_param(&mut self, id: u32, value: f32) {
        self.set_param_smooth(id, value, self.smooth_samples);
    }

    /// `set_param` with an explicit glide in samples (0 jumps; automation uses that).
    pub fn set_param_smooth(&mut self, id: u32, value: f32, s: f64) {
        if !value.is_finite() {
            return;
        }
        match id {
            P_CUTOFF => self.cutoff_log2.set_target((value.clamp(CUTOFF_MIN, CUTOFF_MAX) as f64).log2(), s),
            P_RESONANCE => self.resonance.set_target(value.clamp(0.0, 1.0) as f64, s),
            P_DECAY_MS => self.decay_ms = value.clamp(DECAY_MIN_MS, DECAY_MAX_MS),
            P_GAIN => self.gain.set_target(value.clamp(0.0, 2.0) as f64, s),
            _ => {}
        }
    }

    /// Hit the drum. `start` is the note's start on the caller's clock (timeline samples); it
    /// seeds the noise. A hit still ringing is faded out over [`DECLICK`] samples.
    pub fn note_on(&mut self, velocity: f32, start: i64) {
        self.fade_current();
        self.cur = Strike { svf: Svf::new(), rng: seed_from(start), env: 1.0, velocity: velocity.clamp(0.0, 1.0) };
    }

    /// Fade out whatever is ringing (transport stop / seek).
    pub fn release_all(&mut self) {
        self.fade_current();
    }

    fn fade_current(&mut self) {
        if self.cur.live() {
            self.old = self.cur.clone();
            self.fade_left = DECLICK;
        }
        self.cur.env = 0.0;
    }

    /// Hard stop: silence at once (used when the device is bypassed).
    pub fn reset(&mut self) {
        self.cur.env = 0.0;
        self.old.env = 0.0;
        self.fade_left = 0;
    }

    pub fn is_active(&self) -> bool {
        self.cur.live() || (self.old.live() && self.fade_left > 0)
    }

    /// Add the mono output into `out`.
    pub fn render_add(&mut self, out: &mut [f32]) {
        for chunk in out.chunks_mut(SUB_BLOCK) {
            self.render_block(chunk);
        }
    }

    fn render_block(&mut self, out: &mut [f32]) {
        let len = out.len();
        // Control values at the block start; the gain is interpolated linearly per sample.
        let cutoff = self.cutoff_log2.value().exp2() as f32;
        let res = self.resonance.value() as f32;
        let g0 = self.gain.value() as f32;
        self.cutoff_log2.advance(len);
        self.resonance.advance(len);
        let g1 = self.gain.advance(len) as f32;
        let dg = (g1 - g0) / len as f32;
        let damping = DAMPING_BUTTERWORTH * (DAMPING_RINGING / DAMPING_BUTTERWORTH).powf(res);
        // 60 dB over the decay time.
        let k = (-6.907_755_3 / (self.decay_ms * 1e-3 * self.sample_rate)).exp();

        let fading = self.fade_left > 0 && self.old.live();
        if self.cur.live() {
            self.cur.svf.set_hz(cutoff, damping, self.sample_rate);
        }
        if fading {
            self.old.svf.set_hz(cutoff, damping, self.sample_rate);
        }
        let mut g = g0;
        for (i, o) in out.iter_mut().enumerate() {
            g += dg;
            let mut y = 0.0;
            if self.cur.live() {
                let x = self.cur.noise();
                y += self.cur.svf.process(x).lp() * self.cur.env * self.cur.velocity;
                self.cur.env = flush_denormal(self.cur.env * k);
            }
            if fading {
                let fade = self.fade_left.saturating_sub(i as u32) as f32 / DECLICK as f32;
                let x = self.old.noise();
                y += self.old.svf.process(x).lp() * self.old.env * self.old.velocity * fade;
                self.old.env = flush_denormal(self.old.env * k);
            }
            *o += y * g;
        }
        if fading {
            self.fade_left = self.fade_left.saturating_sub(len as u32);
            if self.fade_left == 0 {
                self.old.env = 0.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;

    fn hit(d: &mut LofiDrum, vel: f32, start: i64, n: usize) -> Vec<f32> {
        d.note_on(vel, start);
        let mut out = vec![0.0; n];
        d.render_add(&mut out);
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn same_start_renders_the_same_samples_and_other_starts_differ() {
        let a = hit(&mut LofiDrum::new(SR), 1.0, 12_345, 4000);
        let b = hit(&mut LofiDrum::new(SR), 1.0, 12_345, 4000);
        let c = hit(&mut LofiDrum::new(SR), 1.0, 12_346, 4000);
        assert_eq!(a, b);
        assert!(a != c);
        assert!(rms(&a) > 0.001);
    }

    #[test]
    fn decays_about_60_db_over_the_decay_time_then_goes_silent() {
        let mut d = LofiDrum::new(SR);
        d.set_param_smooth(P_DECAY_MS, 100.0, 0.0);
        d.set_param_smooth(P_CUTOFF, 20000.0, 0.0);
        let out = hit(&mut d, 1.0, 0, 24_000);
        let early = rms(&out[..480]);
        let at_decay = rms(&out[4800 - 240..4800 + 240]);
        let db = 20.0 * (at_decay / early).log10();
        assert!(db < -50.0 && db > -70.0, "level at the decay time: {db} dB");
        assert!(!d.is_active());
    }

    #[test]
    fn velocity_scales_linearly_and_cutoff_darkens() {
        let loud = hit(&mut LofiDrum::new(SR), 1.0, 7, 2000);
        let soft = hit(&mut LofiDrum::new(SR), 0.5, 7, 2000);
        assert!((rms(&soft) / rms(&loud) - 0.5).abs() < 1e-4);
        let mut dark = LofiDrum::new(SR);
        dark.set_param_smooth(P_CUTOFF, 200.0, 0.0);
        let mut bright = LofiDrum::new(SR);
        bright.set_param_smooth(P_CUTOFF, 12000.0, 0.0);
        assert!(rms(&hit(&mut bright, 1.0, 7, 2000)) > 2.0 * rms(&hit(&mut dark, 1.0, 7, 2000)));
    }

    #[test]
    fn a_retrigger_restarts_the_envelope_and_fades_the_old_tail_without_a_jump() {
        let mut d = LofiDrum::new(SR);
        d.set_param_smooth(P_DECAY_MS, 500.0, 0.0);
        d.set_param_smooth(P_GAIN, 1.0, 0.0);
        let mut out = vec![0.0; 3000];
        d.note_on(1.0, 0);
        d.render_add(&mut out[..2000]);
        d.note_on(1.0, 2000);
        d.render_add(&mut out[2000..]);
        // the new hit is as loud as the first, and the sum never jumps by more than a hit's own
        // sample-to-sample movement
        assert!(rms(&out[2100..2400]) > 0.5 * rms(&out[100..400]));
        let max_step = out.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        assert!(max_step < 0.8, "step {max_step}");
        // after the fade only one strike remains
        assert!(!d.old.live() || d.fade_left == 0);
    }

    #[test]
    fn release_all_fades_the_tail_and_reset_silences() {
        let mut d = LofiDrum::new(SR);
        d.note_on(1.0, 0);
        d.release_all();
        let mut out = vec![0.0; 256];
        d.render_add(&mut out);
        assert!(out[200..].iter().all(|&v| v == 0.0));
        d.note_on(1.0, 5);
        d.reset();
        assert!(!d.is_active());
    }
}
