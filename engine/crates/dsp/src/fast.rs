//! Cheap approximations of transcendental functions, for places where the error is far below
//! what the signal path can reveal (`docs/dsp.md` §6). wasm has no `sin`/`exp`/`tanh`
//! instructions, so the exact versions are software calls costing tens of ns each.
//!
//! Everything here is pure f32 / integer arithmetic (`to_bits`/`from_bits` for the bit tricks),
//! so it is deterministic on every host. The functions that use exponent bit tricks clamp their
//! input first (Rust's `as i32` saturates rather than wrapping, but an out-of-range exponent
//! would still produce garbage).
//!
//! # Where each may be used
//!
//! | function | use for | never for |
//! |---|---|---|
//! | [`sin2pi`], [`cos2pi`], [`SineLut`] | sub-audio modulators: LFOs, tremolo, warble, fade/pan curves | audio-rate oscillators, finnwave (its closed form needs exact sines), filter coefficients |
//! | [`exp`], [`exp2`], [`log2`] | gain computers and envelope followers (dB <-> linear) | filter coefficients, anything that must be exact (a gain that has to be exactly 1) |
//! | [`tanh`] | rough, non-audio shaping only: it has slope kinks at every power of two | audio-path saturation: use [`tanh_rational`] |
//! | [`tanh_rational`] | audio-path saturators (smooth, bounded, slope exactly 1 at 0) | needing the true tanh curve |

use std::f32::consts::LN_2;

/// `floor` for the phase wrapping below (a single wasm instruction).
#[inline(always)]
fn floor(x: f32) -> f32 {
    x.floor()
}

/// `e^x` by Schraudolph's bit trick, as a ratio `e^(x/2) / e^(-x/2)` so the errors largely
/// cancel. Relative error under 3% over `-10..10`; the input is clamped to `+-20`.
///
/// Use for: rough envelope shapes. Prefer [`exp2`] where accuracy matters (it is 5e-6).
#[inline]
pub fn exp(x: f32) -> f32 {
    let x = x.clamp(-20.0, 20.0);
    let p = f32::from_bits((1_056_478_197.0 + 6_051_102.0 * x) as i32 as u32);
    let n = f32::from_bits((1_056_478_197.0 - 6_051_102.0 * x) as i32 as u32);
    p / n
}

/// `tanh(x)` by the same trick. Absolute error under 0.03, but the curve has derivative kinks
/// at every power of two, which add low-level harmonics.
///
/// Use for: non-audio shaping. **Not** for audio-path saturation: use [`tanh_rational`].
#[inline]
pub fn tanh(x: f32) -> f32 {
    let x = x.clamp(-20.0, 20.0);
    let p = f32::from_bits((1_064_866_805.0 + 12_102_203.0 * x) as i32 as u32);
    let n = f32::from_bits((1_064_866_805.0 - 12_102_203.0 * x) as i32 as u32);
    (p - n) / (p + n)
}

/// A smooth odd saturator in the shape of `tanh`: `x (27 + x^2) / (27 + 9 x^2)` (a Pade
/// approximant) up to `|x| = 3`, held at `+-1` beyond.
///
/// * Slope exactly 1 at 0, [`tanh_rational_slope`] gives it elsewhere.
/// * Monotonic and bounded by 1 (to f32 rounding). The value is exactly 1 at 3 *and so is the slope 0*, so the
///   clamp joins without a kink (C1; the second derivative jumps).
/// * Absolute error against `tanh` under 0.025.
///
/// Use for: saturators in the audio path (tape colour, delay feedback).
#[inline]
pub fn tanh_rational(x: f32) -> f32 {
    let x = x.clamp(-3.0, 3.0);
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

/// The derivative of [`tanh_rational`]: `(9 - x^2)^2 / (9 (3 + x^2)^2)` inside `|x| < 3`, 0 outside.
#[inline]
pub fn tanh_rational_slope(x: f32) -> f32 {
    if x.abs() >= 3.0 {
        return 0.0;
    }
    let x2 = x * x;
    let a = 9.0 - x2;
    let b = 3.0 + x2;
    a * a / (9.0 * b * b)
}

/// `2^x`: the integer part goes into the exponent field, the fraction is a 5th-order series
/// around 1/2. Relative error under 5e-6; the input is clamped to `+-126`.
///
/// Use for: gain computers and envelope followers.
#[inline]
pub fn exp2(x: f32) -> f32 {
    let x = x.clamp(-126.0, 126.0);
    let fl = floor(x);
    let t = (x - fl - 0.5) * LN_2; // |t| <= 0.35
    // e^t, Taylor to t^5
    let e = 1.0 + t * (1.0 + t * (0.5 + t * (1.0 / 6.0 + t * (1.0 / 24.0 + t * (1.0 / 120.0)))));
    let scale = f32::from_bits(((fl as i32 + 127) as u32) << 23);
    scale * e * std::f32::consts::SQRT_2
}

/// `log2(x)` for normal positive `x` (anything smaller is treated as `f32::MIN_POSITIVE`).
/// The exponent comes from the bits and the mantissa goes through the `atanh` series
/// `ln m = 2 (s + s^3/3 + s^5/5 + s^7/7)`, `s = (m - 1) / (m + 1)`. Absolute error under 1e-6.
///
/// Use for: gain computers and level detectors.
#[inline]
pub fn log2(x: f32) -> f32 {
    ln(x) * std::f32::consts::LOG2_E
}

/// Natural log, same method and limits as [`log2`]. Absolute error under 1e-6 (relative to
/// the result's magnitude, a few ULPs of the exponent part).
#[inline]
pub fn ln(x: f32) -> f32 {
    let bits = x.max(f32::MIN_POSITIVE).to_bits() as i32;
    // Split x = m * 2^e with m in [sqrt(1/2), sqrt(2)): 0x3f3504f3 is the bits of sqrt(1/2).
    let e = (bits - 0x3f35_04f3) >> 23;
    let m = f32::from_bits((bits - (e << 23)) as u32);
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let series = 2.0 * s * (1.0 + s2 * (1.0 / 3.0 + s2 * (0.2 + s2 * (1.0 / 7.0))));
    e as f32 * LN_2 + series
}

/// `sin(2 pi x)` for `x` in cycles (any value; only the fractional part matters): a parabola
/// with a 0.225 correction. Absolute error about 1e-3. Exact at 0, 1/4, 1/2, 3/4.
///
/// Use for: sub-audio modulators (LFOs, tremolo, warble, fades, pans). **Not** for audio-rate
/// oscillators, finnwave, or filter coefficients.
#[inline]
pub fn sin2pi(x: f32) -> f32 {
    let x = x - (0.5 + floor(x));
    let x = x * (16.0 * (x.abs() - 0.5));
    x + 0.225 * x * (x.abs() - 1.0)
}

/// `cos(2 pi x)`, same method and limits as [`sin2pi`].
#[inline]
pub fn cos2pi(x: f32) -> f32 {
    let x = x - (0.25 + floor(x + 0.25));
    let x = x * (16.0 * (x.abs() - 0.5));
    x + 0.225 * x * (x.abs() - 1.0)
}

/// A quarter-wave sine table driven by a `u32` phase (the full period is 2^32), so the phase
/// wraps exactly with no `fract`/`fmod`. Entry `i` holds `sin((i + 0.5) pi / 2 / N)`, so the
/// nearest-entry error is symmetric. With `bits` = 10 the error is under 1e-3.
///
/// Allocates once in [`SineLut::new`]; [`SineLut::sin`] allocates nothing.
///
/// Use for: sub-audio modulators, like [`sin2pi`].
#[derive(Clone, Debug)]
pub struct SineLut {
    tab: Vec<f32>,
    shift: u32,
}

impl SineLut {
    /// A table of `2^bits` entries (`bits` in 1..=16).
    pub fn new(bits: u32) -> Self {
        let bits = bits.clamp(1, 16);
        let n = 1usize << bits;
        let tab = (0..n).map(|i| ((i as f64 + 0.5) * std::f64::consts::FRAC_PI_2 / n as f64).sin() as f32).collect();
        Self { tab, shift: 30 - bits }
    }

    /// `sin` of the phase `t` (2^32 per cycle).
    #[inline]
    pub fn sin(&self, t: u32) -> f32 {
        const M31: u32 = 0x7fff_ffff;
        let mut u = t;
        if u & (1 << 30) != 0 {
            u ^= M31;
        }
        if u <= M31 {
            self.tab[(u >> self.shift) as usize]
        } else {
            -self.tab[((u & M31) >> self.shift) as usize]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Max of `|f(x) - g(x)|` over `n` points of `lo..hi`.
    fn max_err(lo: f64, hi: f64, n: usize, f: impl Fn(f64) -> f64, g: impl Fn(f64) -> f64) -> f64 {
        (0..=n).map(|i| lo + (hi - lo) * i as f64 / n as f64).map(|x| (f(x) - g(x)).abs()).fold(0.0, f64::max)
    }

    #[test]
    fn exp_is_within_a_few_percent_and_clamps() {
        let e = max_err(-10.0, 10.0, 20_000, |x| fast_rel(exp(x as f32) as f64, x.exp()), |_| 0.0);
        assert!(e < 0.03, "exp relative error {e}");
        assert!(exp(1e9).is_finite() && exp(-1e9) > 0.0 && exp(f32::INFINITY).is_finite());
    }
    fn fast_rel(a: f64, b: f64) -> f64 {
        (a - b) / b
    }

    #[test]
    fn tanh_is_close_bounded_and_clamps() {
        let e = max_err(-8.0, 8.0, 20_000, |x| tanh(x as f32) as f64, |x| x.tanh());
        assert!(e < 0.03, "tanh error {e}");
        assert!(tanh(1e9) <= 1.0 && tanh(-1e9) >= -1.0 && tanh(f32::INFINITY).is_finite());
    }

    #[test]
    fn tanh_rational_is_smooth_odd_monotonic_and_bounded() {
        let e = max_err(-8.0, 8.0, 40_000, |x| tanh_rational(x as f32) as f64, |x| x.tanh());
        assert!(e < 0.025, "tanh_rational error {e}");
        assert_eq!(tanh_rational(0.0), 0.0);
        assert!((tanh_rational(1e-4) / 1e-4 - 1.0).abs() < 1e-5, "slope 1 at 0");
        assert_eq!(tanh_rational(3.0), 1.0);
        assert_eq!(tanh_rational(100.0), 1.0);
        let mut prev = f32::MIN;
        for i in -6000..=6000 {
            let x = i as f32 * 1e-3;
            let y = tanh_rational(x);
            assert!(y >= prev - 2e-7 && y.abs() <= 1.0 + 2e-7, "not monotonic/bounded at {x}");
            assert_eq!(y, -tanh_rational(-x), "not odd at {x}");
            prev = y.max(prev);
        }
        // the analytic slope matches a numeric one, and the clamp joins with slope 0 (C1)
        for i in -35..=35 {
            let x = i as f32 * 0.1;
            let h = 1e-3;
            let num = (tanh_rational(x + h) - tanh_rational(x - h)) / (2.0 * h);
            assert!((num - tanh_rational_slope(x)).abs() < 2e-3, "slope at {x}: {num} vs {}", tanh_rational_slope(x));
        }
        assert_eq!(tanh_rational_slope(0.0), 1.0);
        assert!(tanh_rational_slope(2.999) < 1e-5);
    }

    #[test]
    fn exp2_and_log2_are_accurate() {
        let e = max_err(-30.0, 30.0, 60_000, |x| fast_rel(exp2(x as f32) as f64, x.exp2()), |_| 0.0);
        assert!(e < 5e-6, "exp2 relative error {e}");
        assert!(exp2(1e9).is_finite() && exp2(-1e9) >= 0.0);
        let e = max_err(-100.0, 100.0, 200_000, |x| log2(x.exp2() as f32) as f64, |x| (x.exp2() as f32 as f64).log2());
        assert!(e < 2e-5, "log2 error {e}");
        // dense around the octave edges, where the mantissa split changes
        let e = max_err(0.5, 4.0, 100_000, |x| log2(x as f32) as f64, |x| x.log2());
        assert!(e < 1e-6, "log2 error {e}");
        let e = max_err(1e-6, 2.0, 100_000, |x| ln(x as f32) as f64, |x| x.ln());
        assert!(e < 2e-6, "ln error {e}");
        assert!(log2(0.0).is_finite() && log2(-1.0).is_finite() && log2(f32::MIN_POSITIVE / 4.0).is_finite());
        assert_eq!(log2(1.0), 0.0);
    }

    #[test]
    fn sin2pi_and_cos2pi_are_within_a_thousandth() {
        let e = max_err(-5.0, 5.0, 100_000, |x| sin2pi(x as f32) as f64, |x| (std::f64::consts::TAU * x).sin());
        assert!(e < 1.1e-3, "sin2pi error {e}");
        let e = max_err(-5.0, 5.0, 100_000, |x| cos2pi(x as f32) as f64, |x| (std::f64::consts::TAU * x).cos());
        assert!(e < 1.1e-3, "cos2pi error {e}");
        for (x, s) in [(0.0, 0.0), (0.25, 1.0), (0.5, 0.0), (0.75, -1.0), (1.0, 0.0), (-0.25, -1.0)] {
            assert!((sin2pi(x) - s).abs() < 1e-6, "sin2pi({x})");
        }
        assert_eq!(cos2pi(0.0), 1.0);
    }

    #[test]
    fn the_sine_table_is_within_a_thousandth_over_the_whole_period() {
        let lut = SineLut::new(10);
        let e = max_err(0.0, 1.0, 200_000, |x| lut.sin((x.min(0.999_999_9) * 4_294_967_296.0) as u32) as f64, |x| (std::f64::consts::TAU * x).sin());
        assert!(e < 1.6e-3, "lut error {e}");
        assert!(lut.sin(0).abs() < 2e-3 && lut.sin(u32::MAX).abs() < 2e-3);
        assert!((lut.sin(1 << 30) - 1.0).abs() < 1e-5 && (lut.sin(3 << 30) + 1.0).abs() < 1e-5);
    }
}
