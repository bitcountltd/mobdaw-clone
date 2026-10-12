//! A stateful looper voice: a read head that loops a region of a tape at a smoothly changing speed.
//!
//! The head keeps a *phase* (source samples into the loop region) that advances by the current
//! speed every output sample and wraps at the region length; the output is the resampled tape at
//! `start + phase`:
//!
//! ```text
//!   phase += speed_now;  if phase >= length { phase -= length }
//!   out    = resample(tape, start + phase)
//! ```
//!
//! # Speed is live
//! A new target speed takes effect immediately, but `speed_now` glides toward it with a one-pole
//! filter in the log2 domain (time constant [`SPEED_TAU_S`]), so ratios move evenly (0.1x -> 4x is
//! five octaves) and there are no zipper noises or clicks. The phase integrates the smoothed
//! speed, so the read head never jumps.
//!
//! # Warble
//! `warble` (0..1) adds a tape-transport wobble to the speed, in the log2 domain, on top of the
//! smoothed speed: a slow *wow* (~0.7 Hz), a faster *flutter* (~7 Hz) and a slow random drift. At
//! full depth the pitch swings about +-30 cents. The phase integrates the wobbled speed, so the
//! read head stays continuous.
//!
//! # Triggers
//! The voice is stateful on purpose and makes no promise that the same timeline position sounds
//! the same twice. The loop restarts from the region start (phase 0, speed snapped to its target)
//! whenever the caller's `trigger` id changes (a new pad opens or retriggers) or the timeline is
//! discontinuous (play, seek). Matching what you heard live to a restart of the transport is left to
//! recorded automation.
//!
//! # The seam
//! Wrapping from `start + length` back to `start` is a discontinuity. For the first `xf` source
//! samples after every wrap the output is an equal-power crossfade between
//!   * head 1: the loop restarting at `start`, and
//!   * head 2: the audio that *continues past the loop end* (`start + length + phase`),
//! which is exactly what the previous head 1 was playing, so the output stays continuous. (There
//! is no seam to hide on the first pass after a trigger, so there the loop starts clean.)
//!
//! The resampler's filter state is a cache: after any jump (trigger, region edit, wrap) it is
//! rebuilt by running the filter over [`Resampler::warmup`] input samples preceding the read
//! position. The voice uses the clean (first-order hold, Chebyshev-I N7) resampler design.

use crate::resampler::Resampler;
use crate::warble::Warble;
use std::f64::consts::FRAC_PI_2;

/// Crossfade length at the loop seam, in output milliseconds.
pub const XF_MS: f64 = 10.0;
/// Time constant of the speed smoothing (a generous 150 ms).
pub const SPEED_TAU_S: f64 = 0.15;
/// Regions shorter than this (source samples) are treated as empty.
pub const MIN_LENGTH: i64 = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopParams {
    /// Target playback rate, 0.1..4 (clamped by the caller); the voice glides to it.
    pub speed: f64,
    /// Region start on the tape (source samples).
    pub start: i64,
    /// Region length (source samples).
    pub length: i64,
    /// Tape wow/flutter depth, 0..1 (0 is a steady transport).
    pub warble: f64,
    pub sample_rate: f64,
}

#[derive(Clone, Debug)]
pub struct LoopVoice {
    h1: Resampler,
    h2: Resampler,
    h2_on: bool,
    active: bool,
    last_t: i64,
    trigger: i64,
    /// Source samples into the region.
    phase: f64,
    /// log2 of the smoothed speed.
    log_speed: f64,
    /// Whether the head has wrapped since the trigger (before that there is no seam to crossfade).
    wrapped: bool,
    region: (i64, i64),
    /// Warble LFO phases and the smoothed depth.
    warble: Warble,
    depth: f64,
}

impl Default for LoopVoice {
    fn default() -> Self {
        Self {
            h1: Resampler::clean(),
            h2: Resampler::clean(),
            h2_on: false,
            active: false,
            last_t: 0,
            trigger: 0,
            phase: 0.0,
            log_speed: 0.0,
            wrapped: false,
            region: (0, 0),
            warble: Warble::default(),
            depth: 0.0,
        }
    }
}

/// `sin(pi u / 2)` for `u` in `[0, 1]`: an odd Taylor polynomial (error < 1e-9), so the equal-power
/// crossfade needs no libm call per sample.
#[inline(always)]
fn quarter_sin(u: f64) -> f64 {
    let y = u * FRAC_PI_2;
    let y2 = y * y;
    y * (1.0
        + y2 * (-1.0 / 6.0
            + y2 * (1.0 / 120.0
                + y2 * (-1.0 / 5040.0 + y2 * (1.0 / 362_880.0 + y2 * (-1.0 / 39_916_800.0 + y2 * (1.0 / 6_227_020_800.0)))))))
}

impl LoopVoice {
    pub fn new() -> Self {
        Self::default()
    }

    /// The read head on the tape (source samples), for a playhead: `None` before the first
    /// trigger or while the region is unusable.
    pub fn head(&self) -> Option<f64> {
        self.active.then(|| self.region.0 as f64 + self.phase)
    }

    /// Add `l.len()` frames of loop output into `l` and `r`. `tape(i)` is the stereo signal being
    /// looped, at source sample `i`. `trigger` identifies the current gate (a new value restarts the
    /// loop); `t0` is the timeline sample of `l[0]`, used only to notice that time jumped.
    ///
    /// The slow events (retrigger, a live region edit, the wrap at the loop end and the resampler
    /// restarts they cause) can only happen on the first sample of a block or when the phase
    /// crosses the loop end; everything else is the per-sample run: glide the speed, advance the
    /// phase, read one head (two inside the seam crossfade, with polynomial equal-power gains).
    pub fn render_add(
        &mut self,
        p: &LoopParams,
        trigger: i64,
        t0: i64,
        tape: &mut impl FnMut(i64) -> (f32, f32),
        l: &mut [f32],
        r: &mut [f32],
    ) {
        if p.length < MIN_LENGTH || !(p.speed > 0.0) || !p.speed.is_finite() {
            self.active = false;
            return;
        }
        let n = l.len().min(r.len());
        if n == 0 {
            return;
        }
        // The tape may have been edited since the last block.
        self.h1.clear_cache();
        self.h2.clear_cache();
        let len = p.length as f64;
        let start = p.start as f64;
        let target = p.speed.log2();
        let warble = if p.warble.is_finite() { p.warble.clamp(0.0, 1.0) } else { 0.0 };
        let inv_sr = 1.0 / p.sample_rate;
        let coef = 1.0 - (-1.0 / (SPEED_TAU_S * p.sample_rate)).exp();
        let xf_per_speed = XF_MS * 1e-3 * p.sample_rate;
        let xf_max = len * 0.5;

        // Block start: a (re)trigger, or a live region edit; both need a resampler restart.
        let fresh = !self.active || self.last_t + 1 != t0 || self.trigger != trigger;
        let mut region_edit = false;
        if fresh {
            // (re)trigger: the loop starts at the region start, at the target speed
            self.phase = 0.0;
            self.log_speed = target;
            self.wrapped = false;
            self.h2_on = false;
            self.region = (p.start, p.length);
            self.h1.restart(p.start - self.h1.warmup(p.speed));
        } else if self.region != (p.start, p.length) {
            region_edit = true;
        }

        for k in 0..n {
            // Speed: the log2 glide and the warble, then the depth glide (same time constant).
            if k > 0 || !fresh {
                self.log_speed += (target - self.log_speed) * coef;
                if (target - self.log_speed).abs() < 1e-6 {
                    self.log_speed = target;
                }
            }
            self.depth += (warble - self.depth) * coef;
            if self.depth < 1e-6 && warble == 0.0 {
                self.depth = 0.0;
            }
            self.warble.advance(inv_sr);
            let wob = if self.depth > 0.0 { self.depth * self.warble.octaves() } else { 0.0 };
            let speed = (self.log_speed + wob).exp2();
            let scale = (1.0 / speed).min(1.0) as f32;

            // Phase and events.
            let mut jumped = false;
            if k > 0 || !fresh {
                if region_edit && k == 0 {
                    // The region was edited live: keep the phase (folded into the new length) and
                    // re-read from the new position.
                    self.region = (p.start, p.length);
                    self.phase = (self.phase + speed).rem_euclid(len);
                    self.h2_on = false;
                    jumped = true;
                } else {
                    self.phase += speed;
                    if self.phase >= len {
                        self.phase -= len;
                        if self.phase >= len {
                            self.phase = self.phase.rem_euclid(len);
                        }
                        // Wrapped: the old head 1 keeps going past the loop end as head 2.
                        std::mem::swap(&mut self.h1, &mut self.h2);
                        self.wrapped = true;
                        self.h2_on = true;
                        jumped = true; // (head 1 restarts below)
                    }
                }
            }
            let src = start + self.phase;
            if jumped {
                self.h1.restart(src.floor() as i64 - self.h1.warmup(speed));
            }
            let xf = (xf_per_speed * speed).min(xf_max);
            let need2 = self.wrapped && self.phase < xf;
            let a = self.h1.advance(tape, src, scale);
            if need2 {
                if !self.h2_on {
                    self.h2.restart((src + len).floor() as i64 - self.h2.warmup(speed));
                    self.h2_on = true;
                }
                let b = self.h2.advance(tape, src + len, scale);
                let u = self.phase / xf;
                let (gin, gout) = (quarter_sin(u) as f32, quarter_sin(1.0 - u) as f32);
                l[k] += a.0 * gin + b.0 * gout;
                r[k] += a.1 * gin + b.1 * gout;
            } else {
                self.h2_on = false;
                l[k] += a.0;
                r[k] += a.1;
            }
        }
        self.last_t = t0 + n as i64 - 1;
        self.trigger = trigger;
        self.active = true;
    }
}
