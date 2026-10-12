# Engine performance and DSP plan (temporary)

What is left from the October 2026 engine audit. The principles are in [`docs/dsp.md`](../docs/dsp.md). Delete
this file once the list is done or has moved into issues.

Measure with `npm run bench` (wasm under Node/V8; `--out file.json` saves a run, `--compare file.json` diffs
against one). Keep `npm run test:dsp`, `tests/no_alloc.rs` and the client tests passing, and say in the commit
when rendered bits change.

## Done

The 16-track scene (clip + filter, compressor, tremolo, reverb, delay on each) went from 52 % to 12 % of a core.

- Benchmark harness (`engine/crates/bench`, `engine/bench/run.mjs`, `npm run bench`).
- Engine: audio clip fast path (body runs as slice adds), per-track clip cursor, chains and lists as dense indices,
  effects over the whole block (≤ 32-frame pieces with lanes or while a knob glides), ramped automation,
  closed-form track gain ramp, libm-free MIDI rounding, looper tape reads resolved once per block, sleep for idle
  effects, instruments and tracks.
- Filters: `Svf` in Simper form with mix coefficients and a stereo block API (`SvfCoefs`,
  `Svf::process_block_stereo`); `FilterDevice` without the per-sample function pointer, cached coefficients, 0 dB
  skip; EQ device (kind 8, four fused bands).
- `dsp::fast` (wade `math.h` port plus a rational `tanh`); tremolo, lane LFOs and warble without per-sample libm;
  compressor skip path and fast log/exp; tape colour with per-run saturator and ADAA; delay with a mask-indexed
  tape, rate-correct DC blocker and control-rate warble.
- Reverb restructured into contiguous runs (bit-identical output).
- Synth envelope runs, fused oscillator and envelope, lofi drum branch hoisting.
- `Resampler` in exact modal form: `new()` keeps the tape delay's response, `clean()` (Chebyshev-I order 7,
  first-order hold) for the looper.

## Left

- [ ] **Resampler alias rejection.** `clean()` reaches about −51 dB (19 kHz input at 1.37× speed). Try a 7th-order
  elliptic design (modal form allows zeros) and first-order-hold droop compensation (3-tap pre-emphasis). Tighten
  the spur bound in `dsp/tests/resampler.rs` (−45 dB today) to just under what is measured.
- [ ] **Looper voice event runs** (`dsp/src/looper.rs`): compute the run to the next wrap or seam, then a tight
  loop; crossfade gains from a phasor instead of per-sample `sin`/`cos`.
- [ ] **Delay character.** Move the "every pass darkens" low-pass into an explicit tone stage so the delay can use
  `Resampler::clean()`, if wanted.
- [ ] **Synth voices.** finnwave fails in f32 (`docs/dsp.md` §6), so try f64x2 voice pairs.
- [ ] **Explicit f32x4 kernels.** L, R × 2 bands with a one-sample skew for the EQ; 4 modes per vector in the
  resampler (check whether it already vectorizes); interleave the reverb's L and R comb banks.
- [ ] **Sleep gaps.** A delay with warble never sleeps (default warble is 0.25), and a tail device after another
  only sleeps once its input is exactly zero.
- [ ] **EQ device UI.** It shows as plain sliders; a multi-band curve like `client/src/ui/filterCurve.ts` would help.
- [ ] *(Quality, later)* Exponential ADSR segments and an FDN reverb (both change the sound of existing projects),
  decramped bells and shelves near Nyquist.
