use crate::util::flush_denormal;

/// Resonant state-variable filter (topology-preserving transform / zero-delay feedback,
/// after Zavalishin), evaluated in Simper/Cytomic's linear trapezoidal form (shorter
/// dependency chain than the textbook one, same transfer functions and same state). Ported from the wade C++ `state_variable_filter`.
///
/// One tick yields low-pass, band-pass and high-pass outputs simultaneously. Unlike a
/// direct-form biquad, the state variables are the two integrator (capacitor) states, so the
/// filter stays well behaved when cutoff and damping change every sample.
///
/// # Math
/// Continuous prototype, with `s` normalised to the cutoff and `R` the damping:
///
/// ```text
/// HP = s^2 / (s^2 + 2R s + 1)    BP = s / (s^2 + 2R s + 1)    LP = 1 / (s^2 + 2R s + 1)
/// ```
///
/// The two integrators are discretised with the trapezoidal rule (bilinear transform), which
/// maps analog frequency `w` to digital `2*atan(w/2)`. Pre-warping with `g = tan(w0/2)`
/// (w0 in radians/sample) makes the digital cutoff land exactly on `w0` at any frequency, up
/// to Nyquist. The loop is solved algebraically (no unit delay in the feedback path), which
/// gives `a1 = 1 / (1 + g(g + k))` with `k = 2R`.
///
/// * `damping` is `R`; larger means less resonance. `R = 1/sqrt(2)` is Butterworth (maximally
///   flat, -3.01 dB at the cutoff); `Q = 1/(2R)`.
/// * Notch is `lp + hp`, peak is `lp - hp`. Shelves and bells can be built by mixing outputs.
#[derive(Clone, Debug)]
pub struct Svf {
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    x: f32,
    bp: f32,
    lp: f32,
    ic1: f32,
    ic2: f32,
    /// Sample counter: the denormal flush runs every 16th sample, off the feedback chain's critical path.
    n: u32,
}

/// Coefficients of one SVF plus an output mix `out = m0*x + m1*bp + m2*lp`, computed once per
/// block and shared by every channel that uses the same filter.
#[derive(Clone, Copy, Debug)]
pub struct SvfCoefs {
    pub k: f32,
    pub a1: f32,
    pub a2: f32,
    pub a3: f32,
    pub m0: f32,
    pub m1: f32,
    pub m2: f32,
}

impl SvfCoefs {
    /// From the pre-warped `g = tan(w0/2)` and damping `R` (low-pass mix).
    #[inline]
    pub fn from_g(g: f32, damping: f32) -> Self {
        let k = damping * 2.0;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        Self { k, a1, a2, a3: g * a2, m0: 0.0, m1: 0.0, m2: 1.0 }
    }

    /// From a cutoff in Hz; `warp` scales `g` (1.0 for none, see `Svf::set_hz_warped`). The tangent is
    /// evaluated in f64 and the cutoff clamped just below Nyquist.
    pub fn from_hz(cutoff_hz: f32, damping: f32, sample_rate: f32, warp: f32) -> Self {
        let sr = sample_rate as f64;
        let fc = (cutoff_hz as f64).clamp(1.0, 0.499 * sr);
        Self::from_g(((std::f64::consts::PI * fc / sr).tan() * warp as f64) as f32, damping)
    }

    /// Replace the output mix.
    #[inline]
    pub fn with_mix(mut self, m0: f32, m1: f32, m2: f32) -> Self {
        (self.m0, self.m1, self.m2) = (m0, m1, m2);
        self
    }
    pub fn lowpass(self) -> Self {
        self.with_mix(0.0, 0.0, 1.0)
    }
    pub fn bandpass(self) -> Self {
        self.with_mix(0.0, 1.0, 0.0)
    }
    pub fn highpass(self) -> Self {
        let k = self.k;
        self.with_mix(1.0, -k, -1.0)
    }
    pub fn notch(self) -> Self {
        let k = self.k;
        self.with_mix(1.0, -k, 0.0)
    }
    /// `lp - hp`.
    pub fn peak(self) -> Self {
        let k = self.k;
        self.with_mix(-1.0, k, 2.0)
    }
    pub fn allpass(self) -> Self {
        let k = self.k;
        self.with_mix(1.0, -2.0 * k, 0.0)
    }
}

impl Default for Svf {
    fn default() -> Self {
        let mut f = Self { k: 0.0, a1: 1.0, a2: 0.0, a3: 0.0, x: 0.0, bp: 0.0, lp: 0.0, ic1: 0.0, ic2: 0.0, n: 0 };
        f.set_hz(1000.0, std::f32::consts::FRAC_1_SQRT_2, 48000.0);
        f
    }
}

impl Svf {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set from a cutoff in Hz. The tangent is evaluated in f64 so it stays accurate close
    /// to Nyquist, where `tan` blows up; the cutoff is clamped just below Nyquist.
    pub fn set_hz(&mut self, cutoff_hz: f32, damping: f32, sample_rate: f32) {
        self.set_coefs(&SvfCoefs::from_hz(cutoff_hz, damping, sample_rate, 1.0));
    }

    /// Like `set_hz`, with the pre-warped `g` scaled by `warp`. Shelves use it to move the corner (`1/sqrt(A)` for a low
    /// shelf, `sqrt(A)` for a high shelf) so that the shelf's midpoint, not its corner, lands on the cutoff.
    pub fn set_hz_warped(&mut self, cutoff_hz: f32, damping: f32, sample_rate: f32, warp: f32) {
        self.set_coefs(&SvfCoefs::from_hz(cutoff_hz, damping, sample_rate, warp));
    }

    /// `f0` is the cutoff in radians/sample; pre-warped with `tan` (the C++ `set_exact`).
    pub fn set_exact(&mut self, f0: f32, damping: f32) {
        self.set(((f0 / 2.0).tan()) * 2.0, damping);
    }

    /// `f0` is the *already pre-warped* cutoff, `2*tan(w0/2)` (the C++ `set`). Cheap, so it
    /// suits modulation where the caller computes the warp some other way.
    pub fn set(&mut self, f0: f32, damping: f32) {
        self.set_coefs(&SvfCoefs::from_g(f0 / 2.0, damping));
    }

    /// Adopt the filter coefficients of `c` (its mix is ignored by `process`).
    #[inline]
    pub fn set_coefs(&mut self, c: &SvfCoefs) {
        self.k = c.k;
        self.a1 = c.a1;
        self.a2 = c.a2;
        self.a3 = c.a3;
    }

    /// Flush tiny integrator states to exact zero (`process` does this every 16 samples, the block kernel once per block).
    #[inline]
    pub fn flush(&mut self) {
        self.ic1 = flush_denormal(self.ic1);
        self.ic2 = flush_denormal(self.ic2);
    }

    /// Whether both integrators are exactly zero: zero input then gives zero output and leaves the state zero.
    pub fn is_zero(&self) -> bool {
        self.ic1 == 0.0 && self.ic2 == 0.0
    }

    /// Clear the integrator states.
    pub fn reset(&mut self) {
        self.x = 0.0;
        self.bp = 0.0;
        self.lp = 0.0;
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    /// Process one sample; read the results from `lp()`, `bp()`, `hp()` etc.
    #[inline]
    pub fn process(&mut self, x: f32) -> &mut Self {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        // A decaying state needs thousands of samples to cross the denormal range, so flushing it a few
        // samples late is harmless, and a per-sample flush would add ~10 ns to the dependency chain.
        self.n = self.n.wrapping_add(1);
        if self.n & 15 == 0 {
            self.flush();
        }
        self.bp = v1;
        self.lp = v2;
        self.x = x;
        self
    }

    /// Run `l` and `r` through two filters (states `st[0]`, `st[1]`) that share the coefficients `c`, in place, with
    /// output `m0*x + m1*bp + m2*lp`. L and R are interleaved in one loop to overlap their dependency chains, and the
    /// states are denormal-flushed once at the end of the block, not per sample. The slices must be the same length.
    /// The `lp()`/`bp()`/`hp()` readouts are not updated.
    pub fn process_block_stereo(st: &mut [Svf; 2], l: &mut [f32], r: &mut [f32], c: &SvfCoefs) {
        let [a, b] = st;
        let (mut a1l, mut a2l) = (a.ic1, a.ic2);
        let (mut a1r, mut a2r) = (b.ic1, b.ic2);
        for (x, y) in l.iter_mut().zip(r.iter_mut()) {
            let (xl, xr) = (*x, *y);
            let v3l = xl - a2l;
            let v3r = xr - a2r;
            let v1l = c.a1 * a1l + c.a2 * v3l;
            let v1r = c.a1 * a1r + c.a2 * v3r;
            let v2l = a2l + c.a2 * a1l + c.a3 * v3l;
            let v2r = a2r + c.a2 * a1r + c.a3 * v3r;
            a1l = 2.0 * v1l - a1l;
            a1r = 2.0 * v1r - a1r;
            a2l = 2.0 * v2l - a2l;
            a2r = 2.0 * v2r - a2r;
            *x = c.m0 * xl + c.m1 * v1l + c.m2 * v2l;
            *y = c.m0 * xr + c.m1 * v1r + c.m2 * v2r;
        }
        (a.ic1, a.ic2) = (flush_denormal(a1l), flush_denormal(a2l));
        (b.ic1, b.ic2) = (flush_denormal(a1r), flush_denormal(a2r));
    }

    #[inline]
    pub fn lp(&self) -> f32 {
        self.lp
    }
    #[inline]
    pub fn bp(&self) -> f32 {
        self.bp
    }
    #[inline]
    pub fn hp(&self) -> f32 {
        self.x - self.k * self.bp - self.lp
    }
    /// Band-reject: `lp + hp` = (s^2 + 1) / (s^2 + 2R s + 1), zero at the cutoff.
    #[inline]
    pub fn notch(&self) -> f32 {
        self.x - self.k * self.bp
    }
    /// `lp - hp` = (1 - s^2) / (s^2 + 2R s + 1), gain 1/R at the cutoff.
    #[inline]
    pub fn peak(&self) -> f32 {
        self.k * self.bp + 2.0 * self.lp - self.x
    }
}
