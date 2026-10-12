//! A stereo reverb in the Freeverb mould (Jezar): eight parallel damped feedback combs per
//! channel into four series allpasses, with the right channel's delays offset for width.
//!
//! ```text
//!   in (L+R) -> predelay -> 8 x comb (feedback, low-passed by `damp`) -> 4 x allpass -> wet
//!   out = dry * (1 - mix) + wet * mix
//! ```
//!
//! * `size` (0..1) sets the comb feedback, `0.70 + 0.28 * size`: the decay time.
//! * `damp` (0..1) is the one-pole low-pass in each comb's feedback: higher is a darker tail.
//! * Delay lengths are the classic 44.1 kHz tunings scaled to the sample rate. All buffers are
//!   allocated up front (in `new`), so `process` never allocates.

use crate::util::flush_denormal;

const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
/// Right-channel delay offset (44.1 kHz samples).
const SPREAD: usize = 23;
const INPUT_GAIN: f32 = 0.015;
const WET_GAIN: f32 = 3.0;
const ALLPASS_FEEDBACK: f32 = 0.5;
pub const MAX_PREDELAY_MS: f32 = 200.0;

/// Longest block handled in one pass. Every delay line must be longer than the chunk, so that within a
/// chunk a line reads and writes contiguous runs with no feedback through the buffer itself.
const CHUNK: usize = 128;

/// Split `n` consecutive positions of a ring of length `len` (n <= len) starting at `i` into two runs.
#[inline]
fn split_point(i: usize, n: usize, len: usize) -> usize {
    n.min(len - i)
}

#[inline]
fn advance(i: usize, n: usize, len: usize) -> usize {
    let j = i + n;
    if j >= len {
        j - len
    } else {
        j
    }
}

#[derive(Clone, Debug)]
struct Comb {
    buf: Vec<f32>,
    i: usize,
    lp: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], i: 0, lp: 0.0 }
    }
    /// Run all eight combs of one channel over `inp` (`inp.len() <= every buf.len()`), writing the summed
    /// outputs into `acc`. The eight feedback chains are independent, so they are interleaved in one loop
    /// for instruction-level parallelism; the sum is still `((((0 + y0) + y1) + ...) + y7)`.
    fn run_bank(combs: &mut [Comb], inp: &[f32], acc: &mut [f32], feedback: f32, damp: f32) {
        let combs: &mut [Comb; 8] = combs.try_into().expect("eight combs");
        let n = inp.len();
        let one_minus = 1.0 - damp;
        let mut lp: [f32; 8] = std::array::from_fn(|j| combs[j].lp);
        let mut pos = 0;
        while pos < n {
            // Contiguous segment for every comb: stop at the nearest wrap.
            let mut start = [0usize; 8];
            let mut m = n - pos;
            for (j, c) in combs.iter().enumerate() {
                start[j] = advance(c.i, pos, c.buf.len());
                m = m.min(c.buf.len() - start[j]);
            }
            let mut it = combs.iter_mut();
            let mut segs: [&mut [f32]; 8] = std::array::from_fn(|j| {
                let c = it.next().unwrap();
                &mut c.buf[start[j]..start[j] + m]
            });
            let x = &inp[pos..pos + m];
            let out = &mut acc[pos..pos + m];
            let [s0, s1, s2, s3, s4, s5, s6, s7] = &mut segs;
            for k in 0..m {
                let xi = x[k];
                let y = [s0[k], s1[k], s2[k], s3[k], s4[k], s5[k], s6[k], s7[k]];
                for j in 0..8 {
                    lp[j] = flush_denormal(y[j] * one_minus + lp[j] * damp);
                }
                let w: [f32; 8] = std::array::from_fn(|j| flush_denormal(xi + lp[j] * feedback));
                s0[k] = w[0];
                s1[k] = w[1];
                s2[k] = w[2];
                s3[k] = w[3];
                s4[k] = w[4];
                s5[k] = w[5];
                s6[k] = w[6];
                s7[k] = w[7];
                let mut s = 0.0f32;
                for yj in y {
                    s += yj;
                }
                out[k] = s;
            }
            pos += m;
        }
        for (j, c) in combs.iter_mut().enumerate() {
            c.lp = lp[j];
            c.i = advance(c.i, n, c.buf.len());
        }
    }
    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.lp = 0.0;
    }
}

#[derive(Clone, Debug)]
struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], i: 0 }
    }
    /// In place over `x`, `x.len() <= buf.len()`.
    #[inline]
    fn run(&mut self, x: &mut [f32]) {
        let n = x.len();
        let len = self.buf.len();
        let a = split_point(self.i, n, len);
        let (head, tail) = self.buf.split_at_mut(self.i);
        let (x_a, x_b) = x.split_at_mut(a);
        for (b, v) in tail[..a].iter_mut().zip(x_a) {
            let d = *b;
            let xi = *v;
            *v = d - xi;
            *b = flush_denormal(xi + d * ALLPASS_FEEDBACK);
        }
        for (b, v) in head[..n - a].iter_mut().zip(x_b) {
            let d = *b;
            let xi = *v;
            *v = d - xi;
            *b = flush_denormal(xi + d * ALLPASS_FEEDBACK);
        }
        self.i = advance(self.i, n, len);
    }
    fn clear(&mut self) {
        self.buf.fill(0.0);
    }
}

#[derive(Clone, Debug)]
pub struct Reverb {
    combs: [Vec<Comb>; 2],
    allpasses: [Vec<Allpass>; 2],
    predelay: Vec<f32>,
    pre_i: usize,
    pre_len: usize,
    sample_rate: f32,
    /// Largest chunk free of intra-chunk feedback: the shortest delay line, capped at `CHUNK`.
    max_chunk: usize,
}

impl Reverb {
    pub fn new(sample_rate: f32) -> Self {
        let k = sample_rate as f64 / 44100.0;
        let scaled = |n: usize, extra: usize| (((n + extra) as f64) * k).round() as usize;
        let side = |extra: usize| {
            (
                COMBS.iter().map(|&n| Comb::new(scaled(n, extra))).collect::<Vec<_>>(),
                ALLPASSES.iter().map(|&n| Allpass::new(scaled(n, extra))).collect::<Vec<_>>(),
            )
        };
        let ((cl, al), (cr, ar)) = (side(0), side(SPREAD));
        let max_pre = (MAX_PREDELAY_MS as f64 * 1e-3 * sample_rate as f64).ceil() as usize + 1;
        let min_len = cl.iter().map(|c| c.buf.len()).chain(al.iter().map(|a| a.buf.len())).chain(ar.iter().map(|a| a.buf.len())).min().unwrap_or(1);
        let max_chunk = min_len.clamp(1, CHUNK).min(max_pre);
        Self { combs: [cl, cr], allpasses: [al, ar], predelay: vec![0.0; max_pre], pre_i: 0, pre_len: 0, sample_rate, max_chunk }
    }

    /// Samples after which a tail of input at full scale has fallen below -120 dB, for the comb
    /// feedback at `size` (conservative: slowest comb pass, plus the predelay and allpasses).
    pub fn tail_samples(&self, size: f32) -> u64 {
        let feedback = (0.70 + 0.28 * size.clamp(0.0, 1.0)) as f64;
        let longest = self.combs.iter().flatten().map(|c| c.buf.len()).max().unwrap_or(1) as f64;
        let passes = (1e-6f64.ln() / feedback.ln()).ceil() + 2.0;
        (passes * longest) as u64 + self.predelay.len() as u64 + 4096
    }

    /// Clear the tail.
    pub fn reset(&mut self) {
        for c in self.combs.iter_mut().flatten() {
            c.clear();
        }
        for a in self.allpasses.iter_mut().flatten() {
            a.clear();
        }
        self.predelay.fill(0.0);
    }

    /// Process in place. `size`, `damp` in 0..1; `predelay_ms` in 0..=200; `mix` in 0..1.
    ///
    /// Bit-identical to the original per-sample Freeverb loop. The work is interchanged to line-major
    /// over chunks of at most `CHUNK` frames (each line touches contiguous runs, no `%`, no per-sample wrap
    /// branch, no bounds checks), and every sum keeps its original order: comb outputs are added c0..c7
    /// onto 0.0, then the allpasses run in series.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], size: f32, damp: f32, predelay_ms: f32, mix: f32) {
        let feedback = 0.70 + 0.28 * size.clamp(0.0, 1.0);
        let damp = damp.clamp(0.0, 1.0) * 0.4;
        let mix = mix.clamp(0.0, 1.0);
        let pre = ((predelay_ms.clamp(0.0, MAX_PREDELAY_MS) * 1e-3 * self.sample_rate) as usize).min(self.predelay.len() - 1);
        self.pre_len = pre;
        let total = l.len().min(r.len());
        let mut input = [0.0f32; CHUNK];
        let mut wet = [[0.0f32; CHUNK]; 2];
        let mut done = 0;
        while done < total {
            let n = (total - done).min(self.max_chunk);
            let (lc, rc) = (&mut l[done..done + n], &mut r[done..done + n]);
            self.predelay_chunk(lc, rc, &mut input[..n]);
            for (ch, w) in wet.iter_mut().enumerate() {
                let w = &mut w[..n];
                Comb::run_bank(&mut self.combs[ch], &input[..n], w, feedback, damp);
                for a in self.allpasses[ch].iter_mut() {
                    a.run(w);
                }
            }
            let (w0, w1) = (&wet[0][..n], &wet[1][..n]);
            for (((dl, dr), a), b) in lc.iter_mut().zip(rc.iter_mut()).zip(w0).zip(w1) {
                *dl = *dl * (1.0 - mix) + a * WET_GAIN * mix;
                *dr = *dr * (1.0 - mix) + b * WET_GAIN * mix;
            }
            done += n;
        }
    }

    /// Write `(l + r) * INPUT_GAIN` into the predelay ring and read the delayed signal into `out`.
    #[inline]
    fn predelay_chunk(&mut self, l: &[f32], r: &[f32], out: &mut [f32]) {
        let n = out.len();
        let len = self.predelay.len();
        let (pre, i) = (self.pre_len, self.pre_i);
        if pre == 0 {
            // Write-then-read of the same slot is the identity.
            for ((o, &a), &b) in out.iter_mut().zip(l).zip(r) {
                *o = (a + b) * INPUT_GAIN;
            }
            let wa = split_point(i, n, len);
            self.predelay[i..i + wa].copy_from_slice(&out[..wa]);
            self.predelay[..n - wa].copy_from_slice(&out[wa..]);
        } else if pre >= n && pre <= len - n {
            // The read window [i - pre, +n) never overlaps the write window [i, +n), so order is free.
            let rd = if i >= pre { i - pre } else { i + len - pre };
            let ra = split_point(rd, n, len);
            out[..ra].copy_from_slice(&self.predelay[rd..rd + ra]);
            out[ra..].copy_from_slice(&self.predelay[..n - ra]);
            let wa = split_point(i, n, len);
            for ((p, &a), &b) in self.predelay[i..i + wa].iter_mut().zip(&l[..wa]).zip(&r[..wa]) {
                *p = (a + b) * INPUT_GAIN;
            }
            for ((p, &a), &b) in self.predelay[..n - wa].iter_mut().zip(&l[wa..]).zip(&r[wa..]) {
                *p = (a + b) * INPUT_GAIN;
            }
        } else {
            // Overlapping windows (very short or nearly full-length predelay): exact per-sample path.
            let mut w = i;
            for ((o, &a), &b) in out.iter_mut().zip(l).zip(r) {
                self.predelay[w] = (a + b) * INPUT_GAIN;
                let rd = if w >= pre { w - pre } else { w + len - pre };
                *o = self.predelay[rd];
                w += 1;
                if w == len {
                    w = 0;
                }
            }
        }
        self.pre_i = advance(i, n, len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The original per-sample implementation, kept as the bit-exactness reference.
    #[allow(dead_code)]
    mod old {
        use super::super::*;
        #[derive(Clone, Debug)]
        struct OComb {
            buf: Vec<f32>,
            i: usize,
            lp: f32,
        }

        impl OComb {
            fn new(len: usize) -> Self {
                Self { buf: vec![0.0; len.max(1)], i: 0, lp: 0.0 }
            }
            #[inline]
            fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
                let y = self.buf[self.i];
                self.lp = flush_denormal(y * (1.0 - damp) + self.lp * damp);
                self.buf[self.i] = flush_denormal(x + self.lp * feedback);
                self.i += 1;
                if self.i == self.buf.len() {
                    self.i = 0;
                }
                y
            }
            fn clear(&mut self) {
                self.buf.fill(0.0);
                self.lp = 0.0;
            }
        }

        #[derive(Clone, Debug)]
        struct OAllpass {
            buf: Vec<f32>,
            i: usize,
        }

        impl OAllpass {
            fn new(len: usize) -> Self {
                Self { buf: vec![0.0; len.max(1)], i: 0 }
            }
            #[inline]
            fn tick(&mut self, x: f32) -> f32 {
                let d = self.buf[self.i];
                let y = d - x;
                self.buf[self.i] = flush_denormal(x + d * ALLPASS_FEEDBACK);
                self.i += 1;
                if self.i == self.buf.len() {
                    self.i = 0;
                }
                y
            }
            fn clear(&mut self) {
                self.buf.fill(0.0);
            }
        }

        #[derive(Clone, Debug)]
        pub struct OldReverb {
            combs: [Vec<OComb>; 2],
            allpasses: [Vec<OAllpass>; 2],
            predelay: Vec<f32>,
            pre_i: usize,
            pre_len: usize,
            sample_rate: f32,
        }

        impl OldReverb {
            pub fn new(sample_rate: f32) -> Self {
                let k = sample_rate as f64 / 44100.0;
                let scaled = |n: usize, extra: usize| (((n + extra) as f64) * k).round() as usize;
                let side = |extra: usize| {
                    (
                        COMBS.iter().map(|&n| OComb::new(scaled(n, extra))).collect::<Vec<_>>(),
                        ALLPASSES.iter().map(|&n| OAllpass::new(scaled(n, extra))).collect::<Vec<_>>(),
                    )
                };
                let ((cl, al), (cr, ar)) = (side(0), side(SPREAD));
                let max_pre = (MAX_PREDELAY_MS as f64 * 1e-3 * sample_rate as f64).ceil() as usize + 1;
                Self { combs: [cl, cr], allpasses: [al, ar], predelay: vec![0.0; max_pre], pre_i: 0, pre_len: 0, sample_rate }
            }

            /// Clear the tail.
            pub fn reset(&mut self) {
                for c in self.combs.iter_mut().flatten() {
                    c.clear();
                }
                for a in self.allpasses.iter_mut().flatten() {
                    a.clear();
                }
                self.predelay.fill(0.0);
            }

            /// Process in place. `size`, `damp` in 0..1; `predelay_ms` in 0..=200; `mix` in 0..1.
            pub fn process(&mut self, l: &mut [f32], r: &mut [f32], size: f32, damp: f32, predelay_ms: f32, mix: f32) {
                let feedback = 0.70 + 0.28 * size.clamp(0.0, 1.0);
                let damp = damp.clamp(0.0, 1.0) * 0.4;
                let mix = mix.clamp(0.0, 1.0);
                let pre = ((predelay_ms.clamp(0.0, MAX_PREDELAY_MS) * 1e-3 * self.sample_rate) as usize).min(self.predelay.len() - 1);
                self.pre_len = pre;
                let n = self.predelay.len();
                for k in 0..l.len().min(r.len()) {
                    let (dl, dr) = (l[k], r[k]);
                    // predelay: write now, read `pre` samples back
                    self.predelay[self.pre_i] = (dl + dr) * INPUT_GAIN;
                    let input = self.predelay[(self.pre_i + n - self.pre_len) % n];
                    self.pre_i = (self.pre_i + 1) % n;
                    let mut wet = [0.0f32; 2];
                    for (ch, w) in wet.iter_mut().enumerate() {
                        let mut s = 0.0;
                        for c in self.combs[ch].iter_mut() {
                            s += c.tick(input, feedback, damp);
                        }
                        for a in self.allpasses[ch].iter_mut() {
                            s = a.tick(s);
                        }
                        *w = s * WET_GAIN;
                    }
                    l[k] = dl * (1.0 - mix) + wet[0] * mix;
                    r[k] = dr * (1.0 - mix) + wet[1] * mix;
                }
            }
        }
    }
    const SR: f32 = 48000.0;

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn an_impulse_rings_out_and_decays_and_dry_mix_is_untouched() {
        let mut rv = Reverb::new(SR);
        let (mut l, mut r) = (vec![0.0f32; 48000], vec![0.0f32; 48000]);
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process(&mut l, &mut r, 0.5, 0.5, 0.0, 1.0);
        let (early, late) = (rms(&l[2000..8000]), rms(&l[40000..]));
        assert!(early > 1e-3, "no tail: {early}");
        assert!(late < early, "tail should decay: {late} vs {early}");
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite() && v.abs() < 2.0));
        assert!(l[3000..].iter().zip(&r[3000..]).any(|(a, b)| a != b), "channels should decorrelate");

        let mut rv = Reverb::new(SR);
        let (mut l, mut r) = (vec![0.5f32; 256], vec![0.25f32; 256]);
        rv.process(&mut l, &mut r, 0.5, 0.5, 0.0, 0.0);
        assert!(l.iter().all(|&v| v == 0.5) && r.iter().all(|&v| v == 0.25));
    }

    #[test]
    fn size_lengthens_the_tail_and_predelay_delays_it() {
        let tail = |size: f32| {
            let mut rv = Reverb::new(SR);
            let (mut l, mut r) = (vec![0.0f32; 96000], vec![0.0f32; 96000]);
            l[0] = 1.0;
            r[0] = 1.0;
            rv.process(&mut l, &mut r, size, 0.3, 0.0, 1.0);
            rms(&l[60000..])
        };
        assert!(tail(1.0) > 5.0 * tail(0.2));

        let mut rv = Reverb::new(SR);
        let (mut l, mut r) = (vec![0.0f32; 12000], vec![0.0f32; 12000]);
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process(&mut l, &mut r, 0.5, 0.3, 100.0, 1.0); // 100 ms = 4800 samples
        assert!(l[..4800].iter().all(|&v| v == 0.0), "silent before the predelay");
        assert!(l[4800..].iter().any(|&v| v != 0.0));
    }

    #[test]
    fn bit_identical_to_the_per_sample_implementation() {
        let mut seed = 12345u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 23) as f32 - 1.0
        };
        for &sr in &[44100.0f32, 48000.0, 22050.0, 8000.0] {
            for &block in &[1usize, 7, 32, 128, 300] {
                for &(size, damp, pre, mix) in &[
                    (0.6f32, 0.5f32, 20.0f32, 0.3f32),
                    (1.0, 0.0, 0.0, 1.0),
                    (0.0, 1.0, 1.0, 0.5),
                    (0.9, 0.2, 200.0, 0.7),
                    (0.5, 0.5, 0.05, 0.0),
                ] {
                    let (mut a, mut b) = (Reverb::new(sr), old::OldReverb::new(sr));
                    for blk in 0..(sr as usize / block).min(3000) {
                        // vary predelay mid-stream
                        let p = if blk % 50 == 49 { pre * 0.5 } else { pre };
                        let (mut l1, mut r1): (Vec<f32>, Vec<f32>) = (0..block).map(|_| (noise(), noise())).unzip();
                        let (mut l2, mut r2) = (l1.clone(), r1.clone());
                        a.process(&mut l1, &mut r1, size, damp, p, mix);
                        b.process(&mut l2, &mut r2, size, damp, p, mix);
                        assert!(
                            l1.iter().zip(&l2).chain(r1.iter().zip(&r2)).all(|(x, y)| x.to_bits() == y.to_bits()),
                            "mismatch sr {sr} block {block} params {size} {damp} {pre} {mix} at block {blk}"
                        );
                    }
                }
            }
        }
    }
}
