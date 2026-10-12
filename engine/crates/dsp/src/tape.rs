//! Tape colour for a looper: a soft-clip saturator followed by a low-pass, per channel.
//!
//! ```text
//!   x -> tanh(d*x + b) - tanh(b), / sqrt(d)  -> low-pass (cutoff) -> out
//!
//! (`tanh` here is [`fast::tanh_rational`], a smooth cheap stand-in.)
//! ```
//!
//! `drive` (0..1) maps to `d = 1 + 9*drive`; the small bias `b` makes the curve asymmetric, which
//! adds even harmonics like a tape head does. `1/sqrt(d)` keeps the level roughly steady as the
//! drive rises. At `drive = 0` and a fully open filter the stage is skipped (bit-exact bypass).
//! Both controls glide, so a knob move never zippers.
//!
//! The shaper is anti-aliased with first-order antiderivative anti-aliasing (ADAA, Parker et al.
//! 2016): instead of `f(x[n])` the output is `(F(x[n]) - F(x[n-1])) / (x[n] - x[n-1])` where `F`
//! is the curve's antiderivative, which is the average of `f` over the straight line between the
//! two samples. For the rational tanh, `F(v) = v^2/18 + 4/3 ln(3 + v^2)` inside `|v| <= 3` and
//! it continues with slope 1 beyond. When the two samples are closer than [`ADAA_EPS`] the
//! quotient is ill-conditioned (it subtracts two nearly equal numbers), so the curve at the
//! midpoint is used instead, which is just as accurate there.
//!
//! The curve itself is [`Saturator`], which the tape delay also runs in its feedback loop (with a
//! different output gain: see [`Saturator::unity_gain`]).

use crate::fast;
use crate::smooth::Ramp;
use crate::svf::Svf;

/// The filter range in Hz; at the top it is bypassed.
pub const CUTOFF_MIN: f32 = 200.0;
pub const CUTOFF_MAX: f32 = 20000.0;
const GLIDE_S: f64 = 0.03;
/// The filter coefficients are recomputed every this many samples.
const COEF_EVERY: usize = 8;
/// Below this `|v1 - v0|` (in the shaper's own units) ADAA falls back to the midpoint value.
const ADAA_EPS: f32 = 0.02;

/// The soft-clip curve `tanh(d*x + b) - tanh(b)` for a drive of 0..1: `d = 1 + 9*drive` and
/// `b = 0.25*drive`, with [`fast::tanh_rational`] as the `tanh`. The output is not scaled; pick
/// a gain for the use.
#[derive(Clone, Copy, Debug)]
pub struct Saturator {
    d: f32,
    bias: f32,
    off: f32,
}

/// The antiderivative of [`fast::tanh_rational`] (the curve is exactly `+-1` past `|v| = 3`,
/// where the antiderivative continues with slope 1).
#[inline]
fn antiderivative(v: f32) -> f32 {
    let c = v.clamp(-3.0, 3.0);
    let c2 = c * c;
    c2 * (1.0 / 18.0) + (4.0 / 3.0) * fast::ln(3.0 + c2) + (v.abs() - c.abs())
}

impl Saturator {
    pub fn new(drive: f32) -> Self {
        let (d, bias) = (1.0 + 9.0 * drive, 0.25 * drive);
        Self { d, bias, off: fast::tanh_rational(bias) }
    }

    #[inline]
    pub fn shape(&self, x: f32) -> f32 {
        fast::tanh_rational(self.d * x + self.bias) - self.off
    }

    /// The antiderivative of [`shape`](Self::shape) with respect to the shaper's internal
    /// variable `v = d*x + b` (a constant `off * v` is left out; [`shape_adaa`](Self::shape_adaa)
    /// accounts for it). Pass the result back in as `g0`.
    #[inline]
    pub fn antiderivative(&self, x: f32) -> f32 {
        antiderivative(self.d * x + self.bias)
    }

    /// The anti-aliased output for the step from `x0` to `x1`, and `x1`'s antiderivative to pass
    /// as `g0` next time. `g0` must be `self.antiderivative(x0)`. Equals [`shape`](Self::shape)
    /// for a slowly changing input.
    #[inline]
    pub fn shape_adaa(&self, x0: f32, g0: f32, x1: f32) -> (f32, f32) {
        let (v0, v1) = (self.d * x0 + self.bias, self.d * x1 + self.bias);
        let g1 = antiderivative(v1);
        let dv = v1 - v0;
        let y = if dv.abs() < ADAA_EPS { fast::tanh_rational(0.5 * (v0 + v1)) } else { (g1 - g0) / dv };
        (y - self.off, g1)
    }

    /// `1/sqrt(d)`: keeps the level of a loud signal roughly steady as the drive rises (the
    /// looper's tape colour).
    #[inline]
    pub fn level_gain(&self) -> f32 {
        1.0 / self.d.sqrt()
    }

    /// The reciprocal of the curve's slope at zero, so small signals pass at exactly unity and
    /// only the peaks are held back (to about `1/d`). For use inside a feedback loop, where the
    /// small-signal gain decides whether the tail decays.
    #[inline]
    pub fn unity_gain(&self) -> f32 {
        1.0 / (self.d * fast::tanh_rational_slope(self.bias))
    }
}

#[derive(Clone, Debug)]
pub struct TapeColor {
    drive: Ramp,
    /// log2 of the cutoff in Hz.
    log_cutoff: Ramp,
    l: Svf,
    r: Svf,
    filtering: bool,
    /// The previous input sample per channel and its antiderivative, for ADAA.
    prev: [f32; 2],
    /// The `(log2 cutoff, sample rate)` the filters were last set for.
    set_for: (f64, f64),
}

impl Default for TapeColor {
    fn default() -> Self {
        Self { drive: Ramp::new(0.0), log_cutoff: Ramp::new((CUTOFF_MAX as f64).log2()), l: Svf::new(), r: Svf::new(), filtering: false, prev: [0.0; 2], set_for: (f64::NAN, 0.0) }
    }
}

impl TapeColor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the targets: `drive` 0..1, `cutoff_hz` clamped to the filter range. `snap` jumps there
    /// (a freshly loaded looper) instead of gliding.
    pub fn set(&mut self, drive: f32, cutoff_hz: f32, sample_rate: f64, snap: bool) {
        let drive = if drive.is_finite() { drive.clamp(0.0, 1.0) } else { 0.0 };
        let cutoff = if cutoff_hz.is_finite() { cutoff_hz.clamp(CUTOFF_MIN, CUTOFF_MAX) } else { CUTOFF_MAX };
        let n = GLIDE_S * sample_rate;
        self.drive.set_target(drive as f64, n);
        self.log_cutoff.set_target((cutoff as f64).log2(), n);
        if snap {
            self.drive.snap();
            self.log_cutoff.snap();
        }
    }

    /// Process `l`/`r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f64) {
        let open = (CUTOFF_MAX as f64).log2();
        let idle = |d: &Ramp, c: &Ramp| d.value() == 0.0 && d.target() == 0.0 && c.value() >= open && c.target() >= open;
        if idle(&self.drive, &self.log_cutoff) {
            self.filtering = false;
            return;
        }
        let n = l.len().min(r.len());
        if !self.filtering {
            // coming out of bypass: don't let stale filter state ring in
            self.l.reset();
            self.r.reset();
            self.filtering = true;
            self.set_for.0 = f64::NAN;
            if n > 0 {
                self.prev = [l[0], r[0]];
            }
        }
        let mut k = 0;
        while k < n {
            let m = COEF_EVERY.min(n - k);
            let drive = self.drive.value() as f32;
            let lc = self.log_cutoff.value();
            self.drive.advance(m);
            self.log_cutoff.advance(m);
            if self.set_for != (lc, sample_rate) {
                let hz = lc.exp2() as f32;
                self.l.set_hz(hz, std::f32::consts::FRAC_1_SQRT_2, sample_rate as f32);
                self.r.set_hz(hz, std::f32::consts::FRAC_1_SQRT_2, sample_rate as f32);
                self.set_for = (lc, sample_rate);
            }
            let (ls, rs) = (&mut l[k..k + m], &mut r[k..k + m]);
            if drive > 0.0 {
                let sat = Saturator::new(drive);
                let norm = sat.level_gain();
                let [mut pl, mut pr] = self.prev;
                let (mut gl, mut gr) = (sat.antiderivative(pl), sat.antiderivative(pr));
                for (a, b) in ls.iter_mut().zip(rs.iter_mut()) {
                    let (xl, xr) = (*a, *b);
                    let (yl, g1l) = sat.shape_adaa(pl, gl, xl);
                    let (yr, g1r) = sat.shape_adaa(pr, gr, xr);
                    (pl, pr, gl, gr) = (xl, xr, g1l, g1r);
                    *a = self.l.process(yl * norm).lp();
                    *b = self.r.process(yr * norm).lp();
                }
                self.prev = [pl, pr];
            } else {
                if let (Some(&a), Some(&b)) = (ls.last(), rs.last()) {
                    self.prev = [a, b];
                }
                for (a, b) in ls.iter_mut().zip(rs.iter_mut()) {
                    *a = self.l.process(*a).lp();
                    *b = self.r.process(*b).lp();
                }
            }
            k += m;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f64 = 48000.0;

    fn sine(f: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (0.5 * (std::f64::consts::TAU * f * i as f64 / SR).sin()) as f32).collect()
    }
    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn the_unity_gain_curve_passes_small_signals_untouched_and_holds_peaks() {
        for drive in [0.0f32, 0.3, 1.0] {
            let s = Saturator::new(drive);
            let g = s.unity_gain();
            let small = 1e-4f32;
            assert!((s.shape(small) * g / small - 1.0).abs() < 1e-3, "drive {drive}");
            assert!(s.shape(10.0) * g <= 1.0 / (1.0 + 9.0 * drive) + 1e-6, "drive {drive}: peaks not held");
        }
    }

    #[test]
    fn defaults_are_a_bit_exact_bypass() {
        let mut t = TapeColor::new();
        let x = sine(440.0, 512);
        let (mut l, mut r) = (x.clone(), x.clone());
        t.process(&mut l, &mut r, SR);
        assert_eq!(l, x);
        assert_eq!(r, x);
    }

    #[test]
    fn the_filter_darkens_and_the_drive_adds_harmonics() {
        let mut t = TapeColor::new();
        t.set(0.0, 500.0, SR, true);
        let x = sine(8000.0, 4096);
        let (mut l, mut r) = (x.clone(), x.clone());
        t.process(&mut l, &mut r, SR);
        assert!(rms(&l[1024..]) < 0.05 * rms(&x[1024..]), "8 kHz through a 500 Hz low-pass");

        // saturating a 1 kHz sine puts energy at 3 kHz (odd harmonic) that a clean one lacks
        let bin = |y: &[f32], f: f64| {
            let w = std::f64::consts::TAU * f / SR;
            let (s, c) = y.iter().enumerate().fold((0.0, 0.0), |(s, c), (i, v)| (s + *v as f64 * (w * i as f64).sin(), c + *v as f64 * (w * i as f64).cos()));
            (s * s + c * c).sqrt() / y.len() as f64
        };
        let mut t = TapeColor::new();
        t.set(1.0, CUTOFF_MAX, SR, true);
        let x = sine(1000.0, 4800);
        let (mut l, mut r) = (x.clone(), x.clone());
        t.process(&mut l, &mut r, SR);
        assert!(bin(&l, 3000.0) > 20.0 * bin(&x, 3000.0).max(1e-6), "no harmonics");
        assert!(rms(&l).is_finite() && l.iter().all(|v| v.abs() < 2.0));
    }

    #[test]
    fn adaa_matches_the_exact_average_and_cuts_aliasing() {
        let sat = Saturator::new(1.0);
        // against the exact quotient in f64 (F as a plain f64 formula), on a wild input
        let f = |v: f64| -> f64 {
            let c = v.clamp(-3.0, 3.0);
            c * c / 18.0 + 4.0 / 3.0 * (3.0 + c * c).ln() + (v.abs() - c.abs())
        };
        let (mut x0, mut worst) = (0.0f32, 0.0f64);
        let mut g0 = sat.antiderivative(x0);
        for i in 1..5000 {
            let x1 = (i as f32 * 0.7).sin() * 0.9 * (i as f32 * 0.013).cos();
            let (y, g1) = sat.shape_adaa(x0, g0, x1);
            let (v0, v1) = (10.0 * x0 as f64 + 0.25, 10.0 * x1 as f64 + 0.25);
            let want = if (v1 - v0).abs() < 1e-9 { 0.0 } else { (f(v1) - f(v0)) / (v1 - v0) - fast::tanh_rational(0.25) as f64 };
            if (v1 - v0).abs() > 1e-3 {
                worst = worst.max((y as f64 - want).abs());
            }
            (x0, g0) = (x1, g1);
        }
        assert!(worst < 1e-3, "ADAA error {worst}");

        // a 5 kHz sine, hard driven: the 7th/9th harmonics fold to 13 kHz and 3 kHz
        let n = 4800;
        let x: Vec<f32> = (0..n).map(|i| (std::f64::consts::TAU * 5000.0 * i as f64 / SR).sin() as f32 * 0.9).collect();
        let plain: Vec<f32> = x.iter().map(|&v| sat.shape(v)).collect();
        let mut g = sat.antiderivative(x[0]);
        let mut p = x[0];
        let adaa: Vec<f32> = x
            .iter()
            .map(|&v| {
                let (y, g1) = sat.shape_adaa(p, g, v);
                (p, g) = (v, g1);
                y
            })
            .collect();
        let bin = |y: &[f32], f: f64| {
            let w = std::f64::consts::TAU * f / SR;
            let (s, c) = y.iter().enumerate().fold((0.0, 0.0), |(s, c), (i, v)| (s + *v as f64 * (w * i as f64).sin(), c + *v as f64 * (w * i as f64).cos()));
            (s * s + c * c).sqrt() / y.len() as f64
        };
        for f in [3000.0, 13000.0] {
            assert!(bin(&adaa, f) < 0.5 * bin(&plain, f), "{f} Hz: {} vs {}", bin(&adaa, f), bin(&plain, f));
        }
    }
}
