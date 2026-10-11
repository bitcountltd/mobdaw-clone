# TEMP: metronome, drum grid, multiple synths (design sketch)

Working design for this feature set. Delete this file (folding anything durable into `spec.md` /
`engine-api.md` / `engine.md`) once it's built.

## Goal

Record multi-track songs against a click, without a project-level bpm/time-sig. The metronome is not a
special feature: it falls out of general pieces that are each useful on their own.

- No global tempo. Tempo stays per MIDI clip (`MidiClip.bpm`), as today.
- The metronome is an ordinary MIDI track with ordinary synths and an ordinary (looping) MIDI clip.
- The top-bar metronome button is only a shortcut that creates / mutes that track.

## Pieces, in build order

### 1. Export range = what's audible

`contentEnd` (`client/src/audio/render.ts`) currently counts every clip, muted or not.

- `contentEnd` skips tracks that are muted, and tracks silenced by solo (if any track is soloed, only soloed
  tracks — and `role: 'click'` tracks, see §6 — count; but a muted click track never counts).
- Add a matching `contentStart`: the earliest audible clip/pad start. Export renders `[contentStart, contentEnd + tail]`.
- Effect: start the song at bar 2 behind a 1-bar count-in, mute the click, export: the count-in is trimmed.
- A looping MIDI clip's extent is its full length (see §2).
- (Optional, later) a "trim leading silence" checkbox in the export dialog. Not needed for v1.

### 2. Looping MIDI clips

- `MidiClip` gains optional `loopTicks?: number`: the pattern length. Absent / 0 = no loop (today's behaviour).
- `lengthTicks` stays the clip's total extent on the timeline. Notes in `[0, loopTicks)` repeat every
  `loopTicks` until `lengthTicks`; notes at or after `loopTicks` are ignored while looping.
  (Decision: the extent stays in ticks, consistent with today, so changing a clip's bpm rescales its
  timeline length. Revisit if that's annoying for the click.)
- Engine: `engine_clip_midi_upsert` gains a `loop_ticks: f64` arg (0 = no loop). Expand repeats at
  scheduling time; note-on/off stay sample-accurate. A note longer than the loop is cut at the loop end.
- UI: dragging a MIDI clip's right edge while it loops extends `lengthTicks` (repeats drawn faded after
  the first pass). A way to turn looping on for a clip (clip context menu: "loop" sets `loopTicks =
  lengthTicks`). The pattern length is edited in the clip's editor (piano roll / drum grid).
- Splitting / trimming the left edge of a looping clip: keep it simple — left-trim shifts the phase
  (`trimMidiLeft` in `client/src/ui/blocks.ts`); if that gets hairy, disallow left-trim on looping clips for v1.

### 3. Instrument note ranges + several synths per track

- `Device` gains optional `keyLo?: number; keyHi?: number` (MIDI 0..127, inclusive). Absent = 0 and 127.
  These are device fields, **not** params (not automatable). No migration: old FINNWAVEs play everything.
- Routing: a MIDI note goes to **every** non-bypassed instrument on the track whose range contains its
  pitch. Overlaps layer; non-overlapping ranges are a split keyboard. No transpose per split (later).
- Signal flow: matching instruments run in parallel, their outputs are summed, then the track's effects
  chain runs in `order` on the sum. (Instruments no longer sit "in" the effect order in practice; keep the
  existing `order` field, just sum all instruments first.)
- Engine: replace "first instrument in the chain" (`engine.rs` ~line 1060) with range routing. New API
  `engine_device_keys(e, h, lo: u32, hi: u32)` (or extra args on `engine_device_upsert`); bridge sends it.
  Seek/stop releases voices on all instruments.
- UI: the synths lane (`synthRow` in `client/src/ui/timeline.ts`) holds any number of instrument cards,
  with a "+" like the FX bar offering instruments (finnwave, lofi drum). Each instrument card shows its
  note range (two small fields, lo / hi, note names like `C1`). Cards reorder / delete like FX cards.

### 4. "lofi drum" synth (new instrument, kind 7)

White noise → SVF lowpass → decay envelope → gain. One-shot.

| param | id | range | default | notes |
|---|---|---|---|---|
| cutoff | 0 | 20..20000 Hz | 2000 | log; SVF lowpass (`dsp::svf`) |
| resonance | 1 | 0..1 | 0.3 | 0 Butterworth, 1 rings (pitched, woodblock-ish click) |
| decay | 2 | 1..2000 ms | 60 | pow; exponential-ish decay from note-on |
| gain | 3 | 0..2 | 0.5 | |

- Velocity scales amplitude linearly. Pitch and note length are ignored.
- **Monophonic**: a new hit restarts the envelope (short declick fade of the old tail, e.g. 64 samples).
- Noise is seeded from the note's start position (timeline sample), so renders are deterministic.
- Mono out, written to both channels (like finnwave).
- Add to `DEVICES` in `shared/src/devices.ts`, the engine device kinds, and `docs/engine-api.md`.
- New lofi drums default to a single-note range (see §5).

### 5. Drum grid view

A drum region is a normal `MidiClip` with `view?: 'drums'` (absent = piano roll). Same notes, same looping,
same export. The clip editor opens the grid instead of the piano roll for these clips.

- **Rows** = the track's instruments whose range is a single note (`keyLo === keyHi`), in synths-lane
  order, labelled with the device's name (and note). Wide-range synths (a finnwave on 0..127) get no row.
- **Last row: "+ add drum"** (styled like "+ add track"): adds a lofi drum to the synths lane with
  `keyLo = keyHi =` the lowest unused single-note key starting at 36 (GM kick) and counting up.
- **Columns**: steps; 4 steps per beat. The clip's length/pattern is set in beats (not bars, so 3/4 is just
  a 3-beat loop). Bpm field as in the piano roll.
- Click a cell to toggle a hit: a note at that row's pitch, fixed short duration (one step), velocity 1.
  Velocity editing later.
- Notes at pitches with no single-note instrument are hidden but kept. Widening a drum's range hides its
  row; narrowing it back to one note brings the row (and its notes) back.
- Creating a MIDI clip offers piano roll vs drums (or a toggle in the editor header switches `view`).

### 6. Metronome button (top bar)

- `Track` gains optional `role?: 'click'`.
- Button lit = a click track exists and is unmuted.
- Press with no click track: create one (in one transaction, one undo step):
  - MIDI track named "click", `role: 'click'`.
  - Two lofi drums: "accent" (key 37, brighter: higher cutoff, more resonance) and "tick" (key 36, lower).
  - A drum-view MIDI clip at 0, 120 bpm, `loopTicks` = 1 bar of 4/4, `lengthTicks` = 4 bars, notes: tick on all
    four beats, accent doubled onto beat 1 (muting the accent synth leaves a plain click).
- Press with a click track: toggle its `muted`.
- Deleting the track is fine; the next press makes a new one.
- **Solo**: `role: 'click'` tracks ignore solo (still audible when another track is soloed; their own
  mute still applies). Needs a flag on the engine track (e.g. extra `solo_safe` arg to `track_upsert`).
- Count-in: no special handling. Start the song at bar 2; the export trim (§1) removes the lead-in once the
  click is muted. A transport pre-roll for punch-ins is out of scope.

## Out of scope (v1)

Global tempo map, bar lines / snap to grid, MIDI clips following a project tempo, per-instrument fx chains,
per-split transpose, velocity editing in the drum grid, transport pre-roll, "exclude from export" flag.
