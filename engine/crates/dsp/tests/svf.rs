use dsp::svf::SvfCoefs;
use dsp::Svf;
use std::f64::consts::TAU;

const SR: f32 = 48000.0;
const BUTTERWORTH: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Steady-state gain in dB of one SVF output for a sine at `freq_hz`.
/// Runs a sine through the filter, discards the transient, and compares RMS in/out.
fn gain_db(freq_hz: f64, cutoff_hz: f32, damping: f32, pick: impl Fn(&Svf) -> f32) -> f64 {
    let mut f = Svf::new();
    f.set_hz(cutoff_hz, damping, SR);
    let (settle, measure) = (50_000, 200_000);
    let (mut e_in, mut e_out) = (0.0f64, 0.0f64);
    for n in 0..settle + measure {
        let x = (TAU * freq_hz / SR as f64 * n as f64).sin() as f32;
        f.process(x);
        if n >= settle {
            e_in += (x as f64).powi(2);
            e_out += (pick(&f) as f64).powi(2);
        }
    }
    10.0 * (e_out / e_in).log10()
}

#[test]
fn lowpass_is_minus_3db_at_cutoff_including_near_nyquist() {
    // Bilinear pre-warping puts the -3.01 dB point exactly at the cutoff for any cutoff.
    let want = -10.0 * 2f64.log10(); // -3.0103 dB
    for fc in [100.0f32, 1000.0, 5000.0, 12000.0, 18000.0, 22000.0, 23500.0] {
        let got = gain_db(fc as f64, fc, BUTTERWORTH, |f| f.lp());
        println!("svf LP @ {fc:>7.0} Hz (SR 48k, R=1/sqrt2): {got:+.4} dB (want {want:+.4})");
        assert!((got - want).abs() < 0.01, "fc={fc}: {got} dB");
    }
}

#[test]
fn lowpass_without_prewarp_would_be_wrong_so_prewarp_is_doing_work() {
    // Sanity: using the *unwarped* g = w0/2 near Nyquist puts the -3 dB point elsewhere.
    let fc = 20000.0f32;
    let w0 = TAU as f32 * fc / SR;
    let mut f = Svf::new();
    f.set(w0, BUTTERWORTH); // no tan(): deliberately wrong
    let (mut e_in, mut e_out) = (0.0, 0.0);
    for n in 0..250_000 {
        let x = (TAU * fc as f64 / SR as f64 * n as f64).sin() as f32;
        f.process(x);
        if n >= 50_000 {
            e_in += (x as f64).powi(2);
            e_out += (f.lp() as f64).powi(2);
        }
    }
    let db = 10.0 * (e_out / e_in as f64).log10();
    println!("svf LP @ 20 kHz with *no* prewarp: {db:+.2} dB (vs -3.01 prewarped)");
    assert!((db + 3.0103).abs() > 1.0);
}

#[test]
fn set_exact_matches_set_hz() {
    let fc = 7000.0f32;
    let a = gain_db(fc as f64, fc, BUTTERWORTH, |f| f.lp());
    let mut f = Svf::new();
    f.set_exact(TAU as f32 * fc / SR, BUTTERWORTH);
    let (mut e_in, mut e_out) = (0.0, 0.0);
    for n in 0..250_000 {
        let x = (TAU * fc as f64 / SR as f64 * n as f64).sin() as f32;
        f.process(x);
        if n >= 50_000 {
            e_in += (x as f64).powi(2);
            e_out += (f.lp() as f64).powi(2);
        }
    }
    let b = 10.0 * (e_out / e_in as f64).log10();
    assert!((a - b).abs() < 0.01, "{a} vs {b}");
}

#[test]
fn hp_bp_notch_peak_sanity() {
    let fc = 2000.0f32;
    let r = BUTTERWORTH;
    let three = -3.0103;
    // At the cutoff HP and BP are both 1/(2R) = -3.01 dB.
    let hp = gain_db(fc as f64, fc, r, |f| f.hp());
    let bp = gain_db(fc as f64, fc, r, |f| f.bp());
    println!("svf @ cutoff: HP {hp:+.3} dB, BP {bp:+.3} dB");
    assert!((hp - three).abs() < 0.01 && (bp - three).abs() < 0.01);
    // Passbands: LP at 1/100 of cutoff ~0 dB, HP at 100x cutoff ~0 dB, and the stopband slopes.
    assert!(gain_db(20.0, fc, r, |f| f.lp()).abs() < 0.01);
    assert!(gain_db(20000.0, fc, r, |f| f.hp()).abs() < 1.0); // 10x cutoff, near Nyquist
    let lp_oct = gain_db(8000.0, fc, r, |f| f.lp()); // two octaves up: ~ -24 dB (12 dB/oct)
    println!("svf LP two octaves above cutoff: {lp_oct:+.2} dB");
    assert!(lp_oct < -22.0 && lp_oct > -26.0);
    // Notch is a null at the cutoff; peak has gain 1/R (+3.01 dB for Butterworth).
    let notch = gain_db(fc as f64, fc, r, |f| f.notch());
    let peak = gain_db(fc as f64, fc, r, |f| f.peak());
    println!("svf @ cutoff: notch {notch:+.1} dB, peak {peak:+.3} dB");
    assert!(notch < -60.0);
    assert!((peak - 3.0103).abs() < 0.01);
    // Away from cutoff the notch passes signal.
    assert!(gain_db(200.0, fc, r, |f| f.notch()).abs() < 0.2);
}

/// Tiny xorshift RNG so the tests need no `rand` dependency and are deterministic.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64 // [0, 1)
    }
}

#[test]
fn stable_under_per_sample_random_modulation_of_cutoff_and_damping() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let mut f = Svf::new();
    let mut peak = [0.0f32; 3];
    for _ in 0..(10 * 48000) {
        let x = (rng.next() * 2.0 - 1.0) as f32;
        let cutoff = 20.0 * (1000.0f64).powf(rng.next()); // log-uniform 20 Hz .. 20 kHz
        let damping = 0.05 + 1.95 * rng.next() as f32; // 0.05 .. 2
        f.set_hz(cutoff as f32, damping, SR);
        f.process(x);
        for (p, v) in peak.iter_mut().zip([f.lp(), f.bp(), f.hp()]) {
            assert!(v.is_finite());
            *p = p.max(v.abs());
        }
    }
    println!("svf 10 s noise, random cutoff+damping per sample: peak |lp|,|bp|,|hp| = {peak:?}");
    assert!(peak.iter().all(|&p| p < 100.0));
}

#[test]
fn denormals_are_flushed_to_exact_zero_in_finite_time() {
    let mut f = Svf::new();
    f.set_hz(1000.0, 0.5, SR);
    f.process(1.0);
    let mut settled_at = None;
    for n in 0..2_000_000 {
        f.process(0.0);
        for v in [f.lp(), f.bp(), f.hp()] {
            assert!(!v.is_subnormal(), "subnormal at sample {n}");
        }
        if f.lp() == 0.0 && f.bp() == 0.0 && f.hp() == 0.0 {
            settled_at = Some(n);
            break;
        }
    }
    let n = settled_at.expect("state never reached exactly 0");
    println!("svf impulse response reached exactly 0.0 after {n} samples ({:.2} s)", n as f64 / 48000.0);
}
/// The pre-Simper Zavalishin implementation, kept as the reference.
#[derive(Clone, Debug)]
#[allow(dead_code)]
struct OldSvf {
    g: f32,
    r2g: f32,
    norm: f32,
    hp: f32,
    bp: f32,
    lp: f32,
    s1: f32,
    s2: f32,
}

impl Default for OldSvf {
    fn default() -> Self {
        let mut f = Self { g: 0.0, r2g: 0.0, norm: 1.0, hp: 0.0, bp: 0.0, lp: 0.0, s1: 0.0, s2: 0.0 };
        f.set_hz(1000.0, std::f32::consts::FRAC_1_SQRT_2, 48000.0);
        f
    }
}

impl OldSvf {
    fn new() -> Self {
        Self::default()
    }

    /// Set from a cutoff in Hz. The tangent is evaluated in f64 so it stays accurate close
    /// to Nyquist, where `tan` blows up; the cutoff is clamped just below Nyquist.
    fn set_hz(&mut self, cutoff_hz: f32, damping: f32, sample_rate: f32) {
        let sr = sample_rate as f64;
        let fc = (cutoff_hz as f64).clamp(1.0, 0.499 * sr);
        self.set_g(((std::f64::consts::PI * fc / sr).tan()) as f32, damping);
    }

    /// Like `set_hz`, with the pre-warped `g` scaled by `warp`. Shelves use it to move the corner (`1/sqrt(A)` for a low
    /// shelf, `sqrt(A)` for a high shelf) so that the shelf's midpoint, not its corner, lands on the cutoff.
    fn set_hz_warped(&mut self, cutoff_hz: f32, damping: f32, sample_rate: f32, warp: f32) {
        let sr = sample_rate as f64;
        let fc = (cutoff_hz as f64).clamp(1.0, 0.499 * sr);
        self.set_g(((std::f64::consts::PI * fc / sr).tan() * warp as f64) as f32, damping);
    }

    /// `f0` is the cutoff in radians/sample; pre-warped with `tan` (the C++ `set_exact`).
    fn set_exact(&mut self, f0: f32, damping: f32) {
        self.set(((f0 / 2.0).tan()) * 2.0, damping);
    }

    /// `f0` is the *already pre-warped* cutoff, `2*tan(w0/2)` (the C++ `set`). Cheap, so it
    /// suits modulation where the caller computes the warp some other way.
    fn set(&mut self, f0: f32, damping: f32) {
        self.set_g(f0 / 2.0, damping);
    }

    #[inline]
    fn set_g(&mut self, g: f32, damping: f32) {
        self.g = g;
        self.r2g = damping * 2.0 + g;
        self.norm = 1.0 / (1.0 + self.r2g * g);
    }

    /// Clear the integrator states.
    fn reset(&mut self) {
        self.hp = 0.0;
        self.bp = 0.0;
        self.lp = 0.0;
        self.s1 = 0.0;
        self.s2 = 0.0;
    }

    /// Process one sample; read the results from `lp()`, `bp()`, `hp()` etc.
    #[inline]
    fn process(&mut self, x: f32) -> &mut Self {
        // Solve the zero-delay loop for the high-pass output first...
        self.hp = (x - self.r2g * self.s1 - self.s2) * self.norm;
        // ...then run the two trapezoidal integrators. Each outputs `g*in + s` and stores
        // `g*in + output` as the next state.
        self.bp = self.g * self.hp + self.s1;
        self.s1 = flush(self.g * self.hp + self.bp);
        self.lp = self.g * self.bp + self.s2;
        self.s2 = flush(self.g * self.bp + self.lp);
        self
    }

    #[inline]
    fn lp(&self) -> f32 {
        self.lp
    }
    #[inline]
    fn bp(&self) -> f32 {
        self.bp
    }
    #[inline]
    fn hp(&self) -> f32 {
        self.hp
    }
    /// Band-reject: `lp + hp` = (s^2 + 1) / (s^2 + 2R s + 1), zero at the cutoff.
    #[inline]
    fn notch(&self) -> f32 {
        self.lp + self.hp
    }
    /// `lp - hp` = (1 - s^2) / (s^2 + 2R s + 1), gain 1/R at the cutoff.
    #[inline]
    fn peak(&self) -> f32 {
        self.lp - self.hp
    }
}

fn flush(x: f32) -> f32 { if x.abs() < 1e-20 { 0.0 } else { x } }

fn noise_vec(n: usize, seed: u64) -> Vec<f32> {
    let mut r = Rng(seed);
    (0..n).map(|_| (r.next() * 2.0 - 1.0) as f32).collect()
}

#[test]
fn simper_matches_old_zavalishin_outputs() {
    let x = noise_vec(48000, 7);
    for (fc, d) in [(100.0f32, 0.7f32), (1000.0, 0.05), (8000.0, 1.0), (20000.0, 0.3), (23500.0, 2.0)] {
        let (mut a, mut b) = (OldSvf::default(), Svf::new());
        a.set_hz(fc, d, SR);
        b.set_hz(fc, d, SR);
        for &v in &x {
            a.process(v);
            b.process(v);
            for (p, q) in [(a.lp(), b.lp()), (a.bp(), b.bp()), (a.hp(), b.hp()), (a.notch(), b.notch()), (a.peak(), b.peak())] {
                let tol = if fc > 20000.0 { 1e-3 } else { 1e-5 }; // g ~ 100 near Nyquist: f32 rounding of the two forms differs more
                assert!((p - q).abs() <= tol * (1.0 + p.abs()), "fc={fc} d={d}: {p} vs {q}");
            }
        }
    }
    // A cutoff sweep (new coefficients every sample).
    let (mut a, mut b) = (OldSvf::default(), Svf::new());
    for (n, &v) in x.iter().enumerate() {
        let fc = 50.0 * (400.0f32).powf(n as f32 / x.len() as f32);
        a.set_hz(fc, 0.4, SR);
        b.set_hz(fc, 0.4, SR);
        a.process(v);
        b.process(v);
        for (p, q) in [(a.lp(), b.lp()), (a.bp(), b.bp()), (a.hp(), b.hp())] {
            assert!((p - q).abs() <= 1e-4 * (1.0 + p.abs()), "sweep n={n}: {p} vs {q}");
        }
    }
}

/// Gain in dB of a block mix against its analytic continuous prototype (bilinear-warped frequency).
fn proto_check(mix: impl Fn(SvfCoefs) -> SvfCoefs, h: impl Fn(f64, f64) -> (f64, f64), name: &str) {
    let (fc, d) = (3000.0f32, 0.4f32);
    for f in [100.0f64, 700.0, 2000.0, 3000.0, 5000.0, 12000.0] {
        let c = mix(SvfCoefs::from_hz(fc, d, SR, 1.0));
        let mut st = [Svf::new(), Svf::new()];
        let n = 100_000;
        let mut l: Vec<f32> = (0..n).map(|i| (TAU * f / SR as f64 * i as f64).sin() as f32).collect();
        let mut r = l.clone();
        let x = l.clone();
        Svf::process_block_stereo(&mut st, &mut l, &mut r, &c);
        assert_eq!(l, r);
        let (mut ei, mut eo) = (0.0f64, 0.0f64);
        for i in 50_000..n {
            ei += (x[i] as f64).powi(2);
            eo += (l[i] as f64).powi(2);
        }
        let got = 10.0 * (eo / ei).log10();
        // Analytic: s = tan(w/2)/tan(w0/2) on the unit-cutoff prototype.
        let s = (std::f64::consts::PI * f / SR as f64).tan() / (std::f64::consts::PI * fc as f64 / SR as f64).tan();
        let (re, im) = h(s, d as f64);
        let want = 10.0 * (re * re + im * im).log10();
        assert!((got - want).abs() < 0.02 || (got < -60.0 && want < -60.0), "{name} f={f}: {got} vs {want}");
    }
}

fn den(s: f64, r: f64) -> (f64, f64) {
    (1.0 - s * s, 2.0 * r * s) // s^2 + 2Rs + 1 with s = j*s_
}
fn div(n: (f64, f64), d: (f64, f64)) -> (f64, f64) {
    let m = d.0 * d.0 + d.1 * d.1;
    ((n.0 * d.0 + n.1 * d.1) / m, (n.1 * d.0 - n.0 * d.1) / m)
}

#[test]
fn block_mixes_match_analytic_prototypes() {
    proto_check(|c| c.lowpass(), |s, r| div((1.0, 0.0), den(s, r)), "lp");
    proto_check(|c| c.highpass(), |s, r| div((-s * s, 0.0), den(s, r)), "hp");
    proto_check(|c| c.bandpass(), |s, r| div((0.0, s), den(s, r)), "bp");
    proto_check(|c| c.notch(), |s, r| div((1.0 - s * s, 0.0), den(s, r)), "notch");
    proto_check(|c| c.peak(), |s, r| div((1.0 + s * s, 0.0), den(s, r)), "peak");
    // allpass: (s^2 - 2Rs + 1) / (s^2 + 2Rs + 1)
    proto_check(|c| c.allpass(), |s, r| div((1.0 - s * s, -2.0 * r * s), den(s, r)), "allpass");
}

#[test]
fn block_api_matches_per_sample_and_is_block_size_independent() {
    let x = noise_vec(4096, 99);
    let c = SvfCoefs::from_hz(1800.0, 0.35, SR, 1.0).highpass();
    // Reference: single-sample path (with per-sample flush; tolerance covers nothing, values are far from 1e-20).
    let mut f = Svf::new();
    f.set_coefs(&c);
    let want: Vec<f32> = x.iter().map(|&v| { f.process(v); c.m0 * v + c.m1 * f.bp() + c.m2 * f.lp() }).collect();
    let mut outs = vec![];
    for bs in [1usize, 7, 32, 128, 4096] {
        let mut st = [Svf::new(), Svf::new()];
        let (mut l, mut r) = (x.clone(), x.clone());
        for (cl, cr) in l.chunks_mut(bs).zip(r.chunks_mut(bs)) {
            Svf::process_block_stereo(&mut st, cl, cr, &c);
        }
        assert_eq!(l, r);
        for (a, b) in l.iter().zip(&want) {
            assert!((a - b).abs() < 1e-5 * (1.0 + b.abs()));
        }
        outs.push(l);
    }
    for o in &outs[1..] {
        assert_eq!(*o, outs[0], "block size changed the output bits");
    }
}

#[test]
fn block_kernel_stable_under_modulation() {
    let mut rng = Rng(12345);
    let mut st = [Svf::new(), Svf::new()];
    let mut peak = 0.0f32;
    for _ in 0..3000 {
        let c = SvfCoefs::from_hz(20.0 * 1000f64.powf(rng.next()) as f32, 0.05 + 1.95 * rng.next() as f32, SR, 1.0).peak();
        let mut l = noise_vec(32, rng.next().to_bits());
        let mut r = l.clone();
        Svf::process_block_stereo(&mut st, &mut l, &mut r, &c);
        for v in l.iter().chain(&r) {
            assert!(v.is_finite());
            peak = peak.max(v.abs());
        }
    }
    assert!(peak < 1000.0, "{peak}");
}
