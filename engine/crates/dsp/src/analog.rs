//! Analog low-pass prototypes in *modal* (partial-fraction) form, computed in `f64` from closed
//! forms, for the variable-rate [`Resampler`](crate::resampler::Resampler).
//!
//! # Idea
//! A strictly proper transfer function `H(s) = sum_k r_k / (s - p_k)` is a bank of complex one-poles
//! `s_k' = p_k s_k + r_k u`, `y = sum Re(...)`. Over an interval `dt` with the input held (ZOH) or
//! ramped (FOH) the state update is exact:
//!
//! ```text
//!   ZOH: s <- e^{p dt} s + r dt phi1(p dt) u0
//!   FOH: s <- e^{p dt} s + r dt [phi1(p dt) u0 + phi2(p dt) (u1 - u0)]
//!   phi1(z) = (e^z - 1) / z,   phi2(z) = (e^z - 1 - z) / z^2
//! ```
//!
//! There is no truncation error and the step is stable for any `dt`, so one filter serves any
//! ratio between input and output sample times. Zeros are fine: the residues absorb the numerator.
//!
//! Poles come in conjugate pairs; only the upper half-plane member (and the real pole, if any) is
//! kept, and the output is `2 Re(s)` for a pair and `s` for the real pole.
//!
//! Design: Chebyshev I (poles in closed form). Time is in units where `wc` is the passband edge in
//! rad per unit.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct C {
    pub re: f64,
    pub im: f64,
}

impl C {
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }
    pub fn mul(self, o: C) -> C {
        C::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
    pub fn add(self, o: C) -> C {
        C::new(self.re + o.re, self.im + o.im)
    }
    pub fn sub(self, o: C) -> C {
        C::new(self.re - o.re, self.im - o.im)
    }
    pub fn scale(self, k: f64) -> C {
        C::new(self.re * k, self.im * k)
    }
    pub fn conj(self) -> C {
        C::new(self.re, -self.im)
    }
    pub fn norm(self) -> f64 {
        self.re.hypot(self.im)
    }
    pub fn div(self, o: C) -> C {
        let d = o.re * o.re + o.im * o.im;
        C::new((self.re * o.re + self.im * o.im) / d, (self.im * o.re - self.re * o.im) / d)
    }
    pub fn exp(self) -> C {
        let m = self.re.exp();
        C::new(m * self.im.cos(), m * self.im.sin())
    }
}

/// `(e^z - 1) / z`.
pub fn phi1(z: C) -> C {
    if z.norm() < 0.05 {
        // Taylor: sum z^n / (n+1)!
        let (mut term, mut sum) = (C::new(1.0, 0.0), C::new(1.0, 0.0));
        for n in 1..10 {
            term = term.mul(z).scale(1.0 / (n + 1) as f64);
            sum = sum.add(term);
        }
        sum
    } else {
        z.exp().sub(C::new(1.0, 0.0)).div(z)
    }
}

/// `(e^z - 1 - z) / z^2`.
pub fn phi2(z: C) -> C {
    if z.norm() < 0.05 {
        // Taylor: sum z^n / (n+2)!
        let (mut term, mut sum) = (C::new(0.5, 0.0), C::new(0.5, 0.0));
        for n in 1..10 {
            term = term.mul(z).scale(1.0 / (n + 2) as f64);
            sum = sum.add(term);
        }
        sum
    } else {
        z.exp().sub(C::new(1.0, 0.0)).sub(z).div(z.mul(z))
    }
}

/// One mode of the partial-fraction expansion.
#[derive(Clone, Copy, Debug)]
pub struct Mode {
    pub pole: C,
    pub residue: C,
    /// A conjugate pair (its conjugate is implied); `false` for a real pole.
    pub pair: bool,
}

/// Partial fractions of `k prod(s - z_j) / prod(s - p_k)` (`poles` complete with conjugates, simple,
/// strictly proper). Returns the upper-half-plane and real modes, in order of increasing imaginary
/// part.
pub fn modes_from_pzk(poles: &[C], zeros: &[C], k: f64) -> Vec<Mode> {
    assert!(zeros.len() < poles.len());
    let mut out = Vec::new();
    for (i, p) in poles.iter().enumerate() {
        if p.im < -1e-12 {
            continue;
        }
        let mut num = C::new(k, 0.0);
        for z in zeros {
            num = num.mul(p.sub(*z));
        }
        let mut den = C::new(1.0, 0.0);
        for (j, q) in poles.iter().enumerate() {
            if j != i {
                den = den.mul(p.sub(*q));
            }
        }
        let pair = p.im.abs() > 1e-12;
        let mut residue = num.div(den);
        if !pair {
            residue.im = 0.0;
        }
        out.push(Mode { pole: *p, residue, pair });
    }
    out.sort_by(|a, b| a.pole.im.partial_cmp(&b.pole.im).unwrap());
    out
}

/// Chebyshev-I low-pass of order `n` with `ripple_db` of passband ripple and passband edge `wc`.
/// DC gain 1 for odd `n`.
pub fn cheby1(n: usize, ripple_db: f64, wc: f64) -> Vec<Mode> {
    let e = (10f64.powf(ripple_db / 10.0) - 1.0).sqrt();
    let v = (1.0 / e).asinh() / n as f64;
    let poles: Vec<C> = (1..=n)
        .map(|k| {
            let th = (2 * k - 1) as f64 * PI / (2 * n) as f64;
            C::new(-v.sinh() * th.sin() * wc, v.cosh() * th.cos() * wc)
        })
        .collect();
    let mut k = C::new(1.0, 0.0);
    for p in &poles {
        k = k.mul(p.scale(-1.0));
    }
    let mut k = k.re;
    if n % 2 == 0 {
        k /= (1.0 + e * e).sqrt();
    }
    modes_from_pzk(&poles, &[], k)
}

/// `|H(j w)|` of a modal design (`w` in rad per time unit).
pub fn response(modes: &[Mode], w: f64) -> f64 {
    let s = C::new(0.0, w);
    let mut h = C::new(0.0, 0.0);
    for m in modes {
        h = h.add(m.residue.div(s.sub(m.pole)));
        if m.pair {
            h = h.add(m.residue.conj().div(s.sub(m.pole.conj())));
        }
    }
    h.norm()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(x: f64) -> f64 {
        20.0 * x.log10()
    }

    #[test]
    fn cheby1_ripple_and_dc() {
        let m = cheby1(5, 2.0, 1.0);
        assert!((response(&m, 0.0) - 1.0).abs() < 1e-12);
        assert!((db(response(&m, 1.0)) + 2.0).abs() < 1e-9);
        assert_eq!(m.len(), 3);
    }
}
