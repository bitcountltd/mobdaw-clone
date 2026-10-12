# Engine performance and DSP plan (temporary)

The working TODO list from the October 2026 engine audit. The principles behind each item are in
[`docs/dsp.md`](../docs/dsp.md). Delete this file once the list is done or has moved into issues.

Numbers are wasm under Node 24 / V8 on an Intel i7-9750H, in ns per stereo frame (see `docs/dsp.md` §1). Every
item should keep `npm run test:dsp` and `tests/no_alloc.rs` passing. Each item that changes rendered bits says so
in its commit.

## 0. Measurement first

- [ ] **Bring the benchmark harness into the repo.**
  - A `bench` crate (a `cdylib` against `dsp` and `engine`), plus a Node script that prints ns/frame and % core.
  - Prototype: `/tmp/mobdaw-bench`, `/tmp/mobdaw-benchjs`.
  - Cover each device, the clip path, the resampler and an engine scene (16 tracks × clip + 5 fx).
  - The scene must restart before each timed run so clips are actually playing.
- [ ] **Record the baseline table** from `docs/dsp.md` §1 in its output, so regressions are visible.

## 1. Quick wins (about a day; small, local changes)

- [ ] **Filter: remove `pick` and use one mix kernel** (`engine/crates/engine/src/device.rs:266`).
  - Today: an indirect call per sample. Removing it: 36 → 29 ns.
  - Express LP/BP/HP/notch/peak as `(m0, m1, m2)` (table in `docs/dsp.md` §7).
- [ ] **Delay: same fix** for its `pick` (`engine/crates/dsp/src/delay.rs:154`).
- [ ] **Audio clip fast path** (`engine/crates/engine/src/clip.rs:49`).
  - Split a block into fade-in, body and fade-out ranges, and the body into one run per loop pass (plus the seam
    crossfade).
  - The body is `dst += src * gain` over slices. Prototype: 22.6 → 1.35 ns/frame.
  - Keep `sample_at` for the fades, the seams and the looper tape reads.
  - A live source splits runs at chunk edges.
- [ ] **Tremolo: control-rate or phasor LFO** (`engine/crates/dsp/src/tremolo.rs:58`).
  - Today: two f64 `sin` per sample, about 42 of its 61 ns.
  - Use wade `fast::sin2pi`, or a re-seeded rotation (both are fine for an LFO; `docs/dsp.md` §6).
  - Triangle and square shapes need no trig at all.
- [ ] **Warble: control-rate evaluation** with linear interpolation (`engine/crates/dsp/src/warble.rs`).
  - Today: five f64 `cos` (delay) or four `sin` (looper) per sample. About 80 ns of the delay's 282.
- [ ] **Delay feedback saturator: cheap shape** (`delay.rs:194`).
  - Today: two `tanhf` per sample (about 70 ns), even at drive 0.
  - Use a smooth rational `tanh` with slope exactly 1 at 0, and keep `unity_gain` consistent with it.
- [ ] **TapeColor: hoist `Saturator::new`** (`engine/crates/dsp/src/tape.rs:122`). Build it per `COEF_EVERY` run,
  not per sample (three `tanh` and a `sqrt` per sample today), and drop the `k % COEF_EVERY` test from the loop.
- [ ] **Compressor: skip and approximate** (`engine/crates/dsp/src/compressor.rs:89`).
  - Skip both `ln` and `exp` while level < threshold − knee/2 and reduction == 0 (a linear-domain compare).
  - Otherwise use fast `log2`/`exp2` (wade `fast::exp` style).
- [ ] **Denormal flush per block** on the recursive state (SVF, combs, compressor, DC blocker), instead of per
  sample. Keep flushing values written into delay buffers.
- [ ] **Closed-form ramps:** `g0 + dg * (i + 1) as f32` instead of `g += dg`.
  - Places: the track gain loop `engine.rs:1210`, the synth `synth.rs:334`, `finnwave.rs:187`, `lofidrum.rs:190`.
  - Check in the wasm that the track loop vectorizes.
- [ ] **Filter coefficients once per run, shared by L and R** (`device.rs:256`, `274`), skipped while the ramps are
  at rest.

## 2. Structural

- [ ] **Chains as dense indices** (`engine.rs:864` `rebuild_routing`, used at `1160`, `1171`, `1198`).
  - Store indices into the device map's storage instead of handles, and add `HandleMap::get_index_mut`.
  - Rebuild after every device insert or remove. Note that `track_remove` doesn't call `rebuild_routing` today.
- [ ] **Effects over the whole block** (`engine.rs:1196`).
  - Render instruments in segments split at notes, then run each effect over the full 128 frames.
  - Split an effect's run only at its own lanes' breakpoints.
- [ ] **Sleep.**
  - Each device reports "output is zero": input all zero, plus the state is zero or the tail has decayed. A
    feedback delay at ≥ 1 never reports it.
  - A track with no audio, idle instruments and every effect asleep skips its chain and its gain loop.
  - Today a reverb on a silent track costs 0.53 % of a core forever.
- [ ] **Clip cursor.**
  - Keep per-track audio clip lists sorted by start, plus a playhead cursor that is reset on seek.
  - Replaces the scan of every clip each block (`engine.rs:990`), about 5 ns per clip per block.
- [ ] **Delay-line indexing.**
  - Reverb: the predelay's `%` twice per sample, and the per-comb wrap branch (`engine/crates/dsp/src/reverb.rs:126`).
  - Delay: `rem_euclid` per read and write (`delay.rs:187`, `201`).
  - Fix: power-of-two buffers with a mask, or two contiguous runs per block.
- [ ] **Looper voice: event runs** (`engine/crates/dsp/src/looper.rs:127`).
  - Compute the run to the next wrap or seam event, then use a tight loop.
  - Compute the crossfade gains from a phasor, not `sin`/`cos` per sample.
- [ ] **Synth inner loop** (`engine/crates/dsp/src/synth.rs:313`).
  - The ADSR becomes start plus step per sub-block, split at stage changes.
  - The `stealing` loop is chosen outside the per-sample loop.
  - Fuse the oscillator and the envelope multiply instead of rendering to `tmp` first.
- [ ] **MIDI note lookup.** `tick_to_sample` calls libm `round` on every binary-search probe (`clip.rs:159`).
  Keep a per-clip next-note cursor, or use a `trunc`-based round that matches the current rounding exactly.

## 3. Filters and EQ

- [ ] **Port `Svf` to Simper's form**, keeping the old type until tests pass. It is the same filter with a shorter
  dependency chain: 25 → 18 ns per stereo frame with L and R interleaved.
- [ ] **Interleave L and R** in every stereo recursive loop: SVF, delay filters, tape colour, reverb channels.
- [ ] **Multi-band EQ device, or fused filter chains.**
  - Fuse bands in one sample loop. Measured on 4 bells: 117 → 38 ns/frame.
  - Skip bands at exactly 0 dB, and reset their state when they re-enter.
- [ ] **Steeper LP/HP** as cascades with per-stage Butterworth damping (if/when slopes are added).
- [ ] *(Later)* An explicit f32x4 kernel: L, R × 2 bands with a one-sample skew.
- [ ] *(Later, quality)* Decramped bells and shelves near Nyquist.

## 4. The tape-loop interpolator (`engine/crates/dsp/src/resampler.rs`, `analog.rs`)

Today the filter is −7.1 dB at 8 kHz, −25 dB at 10 kHz and −37 dB at 12 kHz at speed 1, with ±1 dB of ripple. The
Taylor truncation adds −70 to −80 dB spurs at non-integer speeds. Prototype: `/tmp/mobdaw-resp`
(`src/modal.rs` is exact f64, `src/fast.rs` is the f32 table version).

- [ ] **Modal exact form**, with first-order hold (FOH) input.
  - State at integer input positions; full steps of dt = `scale`, with coefficients cached per scale value.
  - Output evaluated from a 256-entry table over dt ∈ [0, 1].
  - The same `advance(input, to, scale)` contract, so the looper and the delay don't change.
- [ ] **Pick the design.**
  - Candidate: Chebyshev I, 7th order, 0.5 dB, 2.2 rad: −0.9 dB at 8 kHz, −3.4 at 15 kHz; 74 vs 64 ns at speed 1,
    123 vs 146 at speed 4.
  - Its worst alias at 2× speed is −62 dB, against −78 today.
  - Try a 7th-order elliptic to get the alias rejection back at the same cutoff.
- [ ] **Droop compensation:** a fixed 3-tap pre-emphasis on the input samples to flatten FOH's sinc².
- [ ] **f32x4 across the 4 modes** (explicit `core::arch::wasm32`).
- [ ] **Tests.**
  - Passband gain and ripple, plus the worst spur at speeds 0.73, 1, 1.37 and 2 (the prototype's measurement
    harness).
  - Continuity across wraps and restarts.
  - The existing looper and delay tests.
- [ ] **Decide the delay's character.** If "every pass darkens" stays, add it as an explicit tone stage in the
  feedback loop, so the interpolator can be clean.

## 5. DSP quality

- [ ] **Ramped automation.** Evaluate a lane at both ends of a segment and ramp across it (`engine.rs:1187`,
  `device.rs:118`). Today LFO lanes, at rates up to 1 kHz, are a ≤32-sample staircase. Then fix the wording in
  `engine.md` §6.2.
- [ ] **ADAA (or 2× oversampling) for the tape colour and delay saturators.**
- [ ] **finnwave in f32 across voices (owner review).**
  - Rewrite the denominator as `(1 − e^{-b})² + 4 e^{-b} sin²(θ/2)`: it has no cancellation, so f32 is safe.
  - Rotate a half-angle phasor.
  - Then process 4 voices per f32x4 (voices as struct-of-arrays).
  - Keep exact sin/cos seeding: approximate sines audibly degrade finnwave (`docs/dsp.md` §6).
- [ ] **Exponential ADSR segments** (already planned in `adsr.rs`).
- [ ] **Reverb.** An 8-line FDN with a Hadamard mix (stereo input, denser tail, SIMD across lines), or at least 4
  combs per vector in Freeverb.
- [ ] **Delay DC blocker:** compute the pole from the sample rate (`delay.rs:67` is fixed at 0.995).

## 6. Math helpers

- [ ] **A `dsp::fast` module ported from wade `math.h`.**
  - `exp`, `tanh`, `sin2pi`, `cos2pi`, and a `u32`-phase sine LUT.
  - Clamp the inputs of the bit-trick functions.
  - Each function gets a max-error test over its intended range.
  - Document where each may be used (`docs/dsp.md` §6 table). Never use them in finnwave, and never for filter
    coefficients.
