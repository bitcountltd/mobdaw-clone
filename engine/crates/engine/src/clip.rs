//! Audio and MIDI clips, and how they turn into samples and note events.

use crate::source::Source;
use dsp::fade::{clip_edge_gain, fade_in_gain, DECLICK_SAMPLES};
use dsp::FadeShape;

pub enum Clip {
    Audio(AudioClip),
    Midi(MidiClip),
}

/// Plays source frames `[source_offset, source_offset + length)` at timeline
/// `[start, start + length)`. All positions are integer samples.
///
/// With `loop_length` P > 0 the clip reads a looping pass (it only repeats when P < length, but the phase applies either way, so a split-off half that wraps once still sounds right): the pass is the source frames
/// `[source_offset, source_offset + P)`, and timeline sample `t` reads pass position
/// `((t - start) + loop_phase) mod P`. Everything is a pure function of `(t, clip, source)` (for a live source, of the frames written so far),
/// with no state, so a re-upsert mid-play is inaudible and a live take replays identically.
pub struct AudioClip {
    pub track: u32,
    pub source: u32,
    pub start: i64,
    pub length: i64,
    pub source_offset: i64,
    pub gain: f32,
    /// User fades in samples; the 64-sample declick floor is applied when rendering.
    pub fade_in: f64,
    pub fade_out: f64,
    pub shape: FadeShape,
    /// Pass length in samples; 0 means no loop.
    pub loop_length: i64,
    /// Where in the pass the clip's first sample falls, in `[0, loop_length)`.
    pub loop_phase: i64,
    /// The longest seam crossfade (10 ms in samples).
    pub seam_max: i64,
}

impl AudioClip {
    /// The pass length when the clip loops, else `None`.
    fn looping(&self) -> Option<i64> {
        (self.loop_length > 0).then_some(self.loop_length)
    }

    /// Add this clip's contribution to the block starting at timeline sample `block_start`
    /// into `l` and `r` (both `block_len` long). Frames outside the source are silent.
    ///
    /// Per sample the output is `source[offset + k] * (edge_gain(k) * clip_gain)`. Outside the
    /// fades `edge_gain` is exactly 1.0, so with clip gain 1.0 samples are copied bit-exactly.
    pub fn render_add(&self, src: &Source, block_start: i64, l: &mut [f32], r: &mut [f32]) {
        let block_end = block_start + l.len() as i64;
        let t0 = block_start.max(self.start);
        let t1 = block_end.min(self.start + self.length);
        for t in t0..t1 {
            let (a, b) = self.sample_at(src, t);
            let i = (t - block_start) as usize;
            l[i] += a;
            r[i] += b;
        }
    }

    /// The clip's pre-gain signal at clip-local sample `k`. Not looping, it is the source
    /// frame `source_offset + k`. Looping, it is pass position `p = (k + phase) mod P`, with
    /// the seam rule at the end of every pass that another pass follows:
    ///
    /// - `X = min(10 ms, P/4, source_offset)` is the pre-roll the source has before the pass.
    ///   With `X >= 64` the last `X` samples of the pass crossfade (equal-power) into
    ///   `source[offset + p - P]`, the audio just before the pass start, which runs on into
    ///   `source[offset]`. It only uses audio from before the pass end, so a live recording can
    ///   compute it as it goes.
    /// - Otherwise the tail fades out over 64 samples and the next pass's head fades in over 64.
    fn signal(&self, src: &Source, k: i64) -> (f32, f32) {
        let Some(pl) = self.looping() else {
            return src.frame(self.source_offset + k);
        };
        let q = k + self.loop_phase;
        let (pass, p) = (q.div_euclid(pl), q.rem_euclid(pl));
        let tail = src.frame(self.source_offset + p);
        let followed = k + (pl - p) < self.length;
        let x = self.seam_max.min(pl / 4).min(self.source_offset);
        if x >= DECLICK_SAMPLES as i64 {
            if followed && p >= pl - x {
                let prog = (p - (pl - x)) as f64 / x as f64;
                let (go, gi) = (fade_in_gain(FadeShape::EqualPower, 1.0 - prog), fade_in_gain(FadeShape::EqualPower, prog));
                let pre = src.frame(self.source_offset + p - pl);
                return (tail.0 * go + pre.0 * gi, tail.1 * go + pre.1 * gi);
            }
            return tail;
        }
        let n = (DECLICK_SAMPLES as i64).min(pl / 2);
        let mut g = 1.0f32;
        if followed && p >= pl - n {
            g *= fade_in_gain(FadeShape::EqualPower, (pl - 1 - p) as f64 / n as f64);
        }
        if pass >= 1 && p < n {
            g *= fade_in_gain(FadeShape::EqualPower, p as f64 / n as f64);
        }
        (tail.0 * g, tail.1 * g)
    }

    /// This clip's stereo output at timeline sample `t` (silence outside the clip or source).
    /// The looper tracks use it to read a track's audio at arbitrary positions.
    pub fn sample_at(&self, src: &Source, t: i64) -> (f32, f32) {
        let k = t - self.start;
        if k < 0 || k >= self.length {
            return (0.0, 0.0);
        }
        let (a, b) = self.signal(src, k);
        let g = clip_edge_gain(k, self.length, self.fade_in, self.fade_out, self.shape) * self.gain;
        (a * g, b * g)
    }
}

/// A MIDI clip with its own clock: notes live in ticks, `bpm` and `ppq` map them to samples.
/// With `loop_ticks > 0` the notes in `[0, loop_ticks)` repeat every `loop_ticks` up to
/// `length_ticks`, and notes at or after `loop_ticks` are ignored.
pub struct MidiClip {
    pub track: u32,
    pub start: i64,
    pub bpm: f64,
    pub ppq: u32,
    pub length_ticks: f64,
    pub loop_ticks: f64,
}

/// One note, kept in the engine-wide index sorted by `(clip, tick, handle)`. Sorting by tick
/// means a clip's notes are also sorted by start sample (the tick-to-sample map is monotone),
/// so the notes starting inside a time window are found by binary search.
#[derive(Clone, Copy, Debug)]
pub struct NoteEntry {
    pub clip: u32,
    pub handle: u32,
    pub tick: f64,
    pub dur_ticks: f64,
    pub pitch: u32,
    pub velocity: f32,
}

/// The contiguous run of `index` belonging to `clip`.
pub fn clip_notes(index: &[NoteEntry], clip: u32) -> &[NoteEntry] {
    let lo = index.partition_point(|e| e.clip < clip);
    let hi = index.partition_point(|e| e.clip <= clip);
    &index[lo..hi]
}

impl MidiClip {
    fn playable(&self) -> bool {
        self.bpm > 0.0 && self.bpm.is_finite() && self.ppq > 0
    }

    /// The pattern length when the clip loops (shorter than the clip), else `None`.
    fn looping(&self) -> Option<f64> {
        (self.loop_ticks > 0.0 && self.loop_ticks.is_finite() && self.loop_ticks < self.length_ticks).then_some(self.loop_ticks)
    }

    /// `start + round(tick * 60 * sr / (bpm * ppq))`, in f64, rounded once per event
    /// (engine.md section 2). The same expression is used for every event so results are
    /// deterministic on every client.
    pub fn tick_to_sample(&self, tick: f64, sample_rate: f64) -> i64 {
        self.start + (tick * 60.0 * sample_rate / (self.bpm * self.ppq as f64)).round() as i64
    }

    pub fn end_sample(&self, sample_rate: f64) -> i64 {
        self.tick_to_sample(self.length_ticks, sample_rate)
    }

    /// The notes that can play: all of them, or the first pass's (`tick < loop`) when looping.
    /// `notes` is sorted by tick.
    fn pattern<'a>(&self, notes: &'a [NoteEntry]) -> &'a [NoteEntry] {
        match self.looping() {
            Some(lp) => &notes[..notes.partition_point(|e| e.tick < lp)],
            None => notes,
        }
    }

    /// The passes (loop iterations) whose notes may start near sample `at`: one without a loop,
    /// else the one `at` falls in and its neighbours (the rounding of ticks to samples can move a
    /// note by half a sample across a pass edge).
    fn passes(&self, at: i64, sample_rate: f64) -> std::ops::Range<i64> {
        let Some(lp) = self.looping() else { return 0..1 };
        let ticks = (at - self.start) as f64 * self.bpm * self.ppq as f64 / (60.0 * sample_rate);
        let here = (ticks / lp).floor().max(0.0) as i64;
        let count = (self.length_ticks / lp).ceil() as i64;
        (here - 1).max(0)..(here + 2).min(count)
    }

    /// The start tick of pass `k`.
    fn pass_origin(&self, k: i64) -> f64 {
        self.looping().map_or(0.0, |lp| k as f64 * lp)
    }

    /// Notes at or after the clip end (or before its start) never play.
    fn note_plays(&self, tick: f64, on: i64, end: i64) -> bool {
        tick >= 0.0 && tick < self.length_ticks && on < end
    }

    /// Start every note whose first sample is exactly `at`, by calling `on(pitch, velocity,
    /// release_at, start)`. Notes whose start lies before `at` are *not* started: that is the
    /// "starting mid-note doesn't retrigger" rule.
    ///
    /// The note's release time is `min(start + round((tick + dur) * k), clip end)`, and at
    /// least one sample after the start, so a note longer than the clip is cut at the clip end
    /// (a looping clip's note is also cut at the end of its pass).
    pub fn fire_at(&self, notes: &[NoteEntry], at: i64, sample_rate: f64, on: &mut impl FnMut(u32, f32, i64, i64)) {
        if !self.playable() {
            return;
        }
        let end = self.end_sample(sample_rate);
        let notes = self.pattern(notes);
        for k in self.passes(at, sample_rate) {
            let origin = self.pass_origin(k);
            let first = notes.partition_point(|e| self.tick_to_sample(origin + e.tick, sample_rate) < at);
            for e in &notes[first..] {
                let tick = origin + e.tick;
                let start = self.tick_to_sample(tick, sample_rate);
                if start != at {
                    break;
                }
                if self.note_plays(tick, start, end) {
                    let mut stop = tick + e.dur_ticks.max(0.0);
                    if let Some(lp) = self.looping() {
                        stop = stop.min(origin + lp);
                    }
                    let off = self.tick_to_sample(stop, sample_rate).min(end).max(start + 1);
                    on(e.pitch, e.velocity, off, start);
                }
            }
        }
    }

    /// The first note start strictly after `at`, or `i64::MAX`. The engine splits its control
    /// blocks there.
    pub fn next_note_on_after(&self, notes: &[NoteEntry], at: i64, sample_rate: f64) -> i64 {
        if !self.playable() {
            return i64::MAX;
        }
        let end = self.end_sample(sample_rate);
        let notes = self.pattern(notes);
        for k in self.passes(at, sample_rate) {
            let origin = self.pass_origin(k);
            let first = notes.partition_point(|e| self.tick_to_sample(origin + e.tick, sample_rate) <= at);
            for e in &notes[first..] {
                let tick = origin + e.tick;
                let on = self.tick_to_sample(tick, sample_rate);
                if self.note_plays(tick, on, end) {
                    return on;
                }
                if tick >= self.length_ticks {
                    break; // sorted by tick: nothing later can play
                }
            }
        }
        i64::MAX
    }
}
