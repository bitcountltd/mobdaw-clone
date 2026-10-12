//! A linear-segment ADSR amplitude envelope.
//!
//! ```text
//!  level
//!   1 |      /\
//!     |     /  \_______ sustain
//!     |    /           \
//!   0 |___/             \____
//!        A   D    S      R
//! ```
//!
//! All segments are straight lines in *amplitude* (exponential segments come later):
//! * attack: `0 -> 1` over `attack` samples (from the current level if retriggered);
//! * decay: `1 -> sustain` over `decay` samples;
//! * sustain: holds `sustain` (and follows it if it changes);
//! * release: from the level at the moment of release to 0, in exactly `release` samples,
//!   whatever that level was.
//!
//! A time of 0 is rounded up to one sample, so a segment always takes at least one step.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
pub struct Adsr {
    stage: Stage,
    level: f32,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    /// Samples elapsed in the current segment, and that segment's length (fixed on entry).
    /// Counting samples, rather than accumulating `level += step`, makes every segment land on
    /// its target on exactly the right sample with no f32 drift.
    pos: u32,
    seg: f32,
    release_from: f32,
}

impl Default for Adsr {
    fn default() -> Self {
        Self {
            stage: Stage::Idle,
            level: 0.0,
            attack: 1.0,
            decay: 1.0,
            sustain: 1.0,
            release: 1.0,
            pos: 0,
            seg: 1.0,
            release_from: 0.0,
        }
    }
}

impl Adsr {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set segment lengths (in samples) and the sustain level (0..1). Cheap; may be called
    /// every control block. A segment's length is read when the segment starts; the sustain
    /// level is read live (the decay target and the held level follow it).
    pub fn set(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        self.attack = attack.max(1.0);
        self.decay = decay.max(1.0);
        self.sustain = sustain.clamp(0.0, 1.0);
        self.release = release.max(1.0);
    }

    fn enter(&mut self, stage: Stage, len: f32) {
        self.stage = stage;
        self.pos = 0;
        self.seg = len;
    }

    /// Start the attack from level 0.
    pub fn note_on(&mut self) {
        self.level = 0.0;
        self.enter(Stage::Attack, self.attack);
    }

    /// Begin the release from wherever the level is now. No-op if already releasing or idle.
    pub fn release(&mut self) {
        if matches!(self.stage, Stage::Idle | Stage::Release) {
            return;
        }
        self.release_from = self.level;
        self.enter(Stage::Release, self.release);
    }

    pub fn reset(&mut self) {
        self.stage = Stage::Idle;
        self.level = 0.0;
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn level(&self) -> f32 {
        self.level
    }

    pub fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    /// Fill `out` with the next `out.len()` levels: exactly the values `next()` would return,
    /// sample by sample (same formulas, same f32 operations), but each linear segment runs as a
    /// tight loop with no per-sample stage dispatch; only the sample on which a segment ends
    /// goes through `next()`.
    pub fn fill(&mut self, out: &mut [f32]) {
        let n = out.len();
        let mut i = 0;
        while i < n {
            // Samples that stay strictly inside the current segment: pos + j < seg.
            let inside = match self.stage {
                Stage::Idle | Stage::Sustain => {
                    let l = self.next();
                    out[i..].fill(l);
                    return;
                }
                _ => (self.seg.ceil() as u32).saturating_sub(self.pos).saturating_sub(1) as usize,
            };
            let run = inside.min(n - i);
            let (pos, seg) = (self.pos, self.seg);
            let dst = &mut out[i..i + run];
            match self.stage {
                Stage::Attack => {
                    for (j, o) in dst.iter_mut().enumerate() {
                        *o = (pos + 1 + j as u32) as f32 / seg;
                    }
                }
                Stage::Decay => {
                    let range = 1.0 - self.sustain;
                    for (j, o) in dst.iter_mut().enumerate() {
                        *o = 1.0 - range * ((pos + 1 + j as u32) as f32 / seg);
                    }
                }
                _ => {
                    let from = self.release_from;
                    for (j, o) in dst.iter_mut().enumerate() {
                        *o = from * (1.0 - (pos + 1 + j as u32) as f32 / seg);
                    }
                }
            }
            if run > 0 {
                self.pos += run as u32;
                self.level = out[i + run - 1];
                i += run;
            }
            if i < n {
                out[i] = self.next(); // the sample that ends the segment
                i += 1;
            }
        }
    }

    /// Advance one sample and return the new level.
    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => {}
            Stage::Attack => {
                self.pos += 1;
                self.level = self.pos as f32 / self.seg;
                if self.pos as f32 >= self.seg {
                    self.level = 1.0;
                    self.enter(Stage::Decay, self.decay);
                }
            }
            Stage::Decay => {
                self.pos += 1;
                self.level = 1.0 - (1.0 - self.sustain) * (self.pos as f32 / self.seg);
                if self.pos as f32 >= self.seg {
                    self.level = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.level = self.sustain,
            Stage::Release => {
                self.pos += 1;
                self.level = self.release_from * (1.0 - self.pos as f32 / self.seg);
                if self.pos as f32 >= self.seg {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.level
    }
}
