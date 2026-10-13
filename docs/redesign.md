# mobdaw redesign (daw.bitcount.com)

The brief every contributor works from. It covers the product and design decisions, the module architecture, and who
owns which files. When the code and this doc disagree, fix one of them.

## 1. Product

mobdaw is a multitrack studio in a browser tab: record, loop, sequence, automate and mix, on a native-speed Rust/wasm
engine. The redesign keeps the engine, the Yjs document and every feature. What changes is the interface, which now
works like a studio:

- **The musical grid comes first.** The project has a tempo and a meter. The ruler counts bars and beats, clips snap to
  the grid, the counter reads `bar.beat.16th` next to the clock, and a loop region (cycle) repeats part of the song.
- **Everything has a place.** Top bar: transport and project-wide settings. Left: the browser of sounds, instruments,
  effects and project audio. Centre: the arrangement. Bottom dock: the detail of whatever is selected, either the
  clip editor (piano roll, drum grid or audio clip) or the selected track's device rack. Mixer: a full view with channel
  strips, switched with the arrange/mix toggle or `Tab`.
- **You can see sound.** Every track and the master have level meters. The top bar has a small master scope.
- **Keyboard-first.** Every common action has a shortcut, `?` lists them all, and the computer keyboard plays the
  selected instrument (`A`–`L` row = white keys, `Z`/`X` octave).
- **A good first five minutes.** The home page offers templates (Empty, Beat, Band, Loop jam) and a built-in demo song
  made entirely from the engine's synths, so nothing has to download. Instrument and drum presets live in the browser.

Deployment is **static only** (S3 + CloudFront at daw.bitcount.com): projects live on the device (IndexedDB) and move as
`.mobdaw` files. Cloud features (accounts, sharing, collaboration, chat) need the Node server. Their code stays, but
it is hidden when `import.meta.env.VITE_CLOUD !== '1'` (the static build). Keep `Session`-level code paths working.

## 2. Visual design

Direction: **a tape-era console.** The surface is warm graphite like an anodised desk, not black. Text is warm
paper-white. Each track carries a cassette-label colour that runs through its header stripe, clips, mixer strip and
meters, so you find a track by its colour everywhere. Meters glow amber up to red. The one bold element is the
**transport counter**: big tabular numerals, the bars counter lit warm, the clock beside it dim. Everything else stays
quiet.

### Tokens (`client/src/theme/tokens.css`)
| token | value | use |
|---|---|---|
| `--bg` | `#17181b` | app background, gutters between tracks |
| `--panel` | `#1f2125` | bars, track headers, dock, browser |
| `--raise` | `#272a2f` | inputs, menus, hovered rows, clip bodies (before tinting) |
| `--line` | `#33373d` | 1px separators, hover tint for buttons |
| `--line-strong` | `#454a52` | focused or selected borders |
| `--fg` | `#ebe6dc` | text |
| `--dim` | `#8f8b84` | secondary text, inactive icons |
| `--faint` | `#5d5b57` | grid lines, disabled |
| `--accent` | `#f0b44c` | lit counter, selection, playhead, toggled-on |
| `--rec` | `#ee5a52` | record, armed, clipping |
| `--ok` | `#7cc489` | meter low range, "saved" |
| `--grid-bar` / `--grid-beat` | `rgba(235,230,220,.10)` / `.04` | lane grid lines |
| `--r-sm` / `--r-md` | `3px` / `6px` | clips and controls / panels, menus, tiles |
| `--track-h` | `64px` | default lane height |

Track colours: `TRACK_COLORS` in `shared/src/tempo.ts` (8 hues). A track's colour comes from `trackColor(track, index)`.
Clip bodies are the track colour at about 22% over `--raise`, with waveforms and notes in the full colour.

### Type
- UI: **Barlow Semi Condensed** (400/500/600), from `@fontsource/barlow-semi-condensed`. It's compact for dense
  controls and has an industrial label feel. Base size 13px; labels 12px; headings 15/18/24px.
- Numerals: `font-variant-numeric: tabular-nums` everywhere numbers change. The transport counter uses
  **Barlow Semi Condensed 600 at 22px**.
- Logo: the existing **Pirata One** blackletter "mobdaw" wordmark, kept as the brand mark (in `--rec`).
- Sentence case for labels, lowercase for buttons and toggles as before ("mute", "solo"). No all-caps labels.

### Controls
- Buttons are quiet. An icon or text button has no background at rest, `--line` on hover, and `--accent` fill with dark
  text when toggled on (`.on`). Record is `--rec`. The original style rule stays: never tint a resting button.
- Icons: a single inline-SVG set (`client/src/theme/icons.ts`), 16px, 1.6px stroke, `currentColor`.
- Every icon-only button has a tooltip naming the action and its shortcut (`title` = "play / pause (space)").
- Knobs for device params (drag up/down, shift = fine, double-click = default, wheel). Faders for track gain. Small
  pan knobs. All controls are keyboard focusable with a visible `--accent` focus ring.
- Menus and popovers use `--raise` with a `--line-strong` border and `--r-md` radius, plus a single soft shadow.

## 3. Layout

```
┌ topbar ───────────────────────────────────────────────────────────────────────────────┐
│ mobdaw  project name ▾ │ ⏮ ▶ ● ⟳ │ 12.3.2  0:24.5 │ 120 bpm 4/4 │ click │ snap 1/16 │ ↶ ↷ │ arrange/mix │ scope │ export ? │
├ browser ┬ ruler: bars/beats, loop brace, playhead ─────────────────────────────────────┤
│ sounds  │ track header │ lane (clips on a bar/beat grid)                                 │
│ synths  │ (colour, name,│                                                                │
│ effects │  m s ● , fader│                                                                │
│ audio   │  meter)       │                                                                │
├─────────┴───────────────┴────────────────────────────────────────────────────────────────┤
│ dock tabs: clip │ devices        (drag the top edge to resize, double-click to collapse) │
│ piano roll / drum grid / audio clip editor   |   device rack of the selected track       │
├ status bar: hint for what's under the cursor · cpu · saved ─────────────────────────────┤
```
- The browser (left, 240px) collapses with `B`. The dock collapses with `D`. The mixer replaces the arrangement with `Tab`.
- Selecting a clip opens it in the dock's clip tab. Selecting a track header shows its devices in the dock.
- Narrow screens (<900px): the browser becomes an overlay drawer and the dock defaults to collapsed.

## 4. Data model additions (`shared/src/tempo.ts`)
- `meta.bpm`, `meta.beatsPerBar`, `meta.loop {start,end,on}`, `Track.color`. Read them with `getTempo`, `getLoop`, and
  `trackColor`. Old projects work without them.
- `setProjectTempo(doc, bpm)` keeps everything on its bar and beat, and makes the click track and all MIDI clips follow.
- Grid: `GridSize`, `snapToGrid`, `gridSamples`, and `visibleGridBeats` (spacing of the drawn lines when zoomed).
- New MIDI clips take the project bpm. New tracks get the next colour (`color = tracks.length % 8`).

## 5. Architecture

The old `client/src/ui/timeline.ts` was a 2000-line function that built the bar, transport, lanes, devices, automation
and editors. It is split into a **Studio** controller plus view modules under `client/src/studio/`:

```
studio/
  studio.ts      Studio: session, doc, playback, UI state, event bus, transport, edit helpers
  shell.ts       mountStudio(session, name, ...) -> { el, destroy }: builds the layout and mounts the views below
  topbar.ts      transport, counter, tempo/meter, click, snap, undo/redo, view switch, scope, export, help
  arrange/       the arrangement: ruler.ts (bars/beats, loop brace), tracks.ts (headers), lanes.ts (clips, pads,
                 loopers, automation; the old timeline core), grid.ts (grid drawing)
  dock/          dock.ts (tabs, resize), clipEditor.ts (wraps noteEditor / drumGrid / audio clip panel), rack.ts (device rack)
  mixer/         mixer.ts (channel strips + master)
  browser/       browser.ts (sounds, synths, effects, project audio; drag sources)
  keys.ts        shortcuts, the ? overlay, computer-keyboard MIDI
  meters.ts      meter and scope rendering
client/src/theme/  tokens.css, base.css, icons.ts, controls.ts (knob, fader, meter, toggle, tooltip helpers)
client/src/content/ presets.ts (instrument/drum/effect presets), templates.ts (new-project templates), demo.ts (demo song)
```

### Studio (the contract between modules)
```ts
type DockTab = 'clip' | 'devices'
type UiState = {
  pps: number                 // zoom, pixels per second
  selection: string[]         // selected clip ids
  focusTrack: string | null   // the track whose devices the dock shows (last clicked header or clip)
  editing: string | null      // the clip open in the dock's clip tab
  dock: { open: boolean; tab: DockTab; height: number }
  browserOpen: boolean
  view: 'arrange' | 'mix'
  grid: GridSize              // snap; default 0.25 (1/16)
  follow: boolean             // keep the playhead in view while playing
  armedTrack: string | null
}
class Studio {
  readonly s: Session; readonly doc: Y.Doc; readonly undo: Y.UndoManager; readonly readOnly: boolean
  rate: number; pb: Playback | null; ui: UiState
  on(ev: 'doc' | 'ui' | 'transport' | 'tick' | 'meters', fn): () => void   // returns unsubscribe
  emit(ev, arg?): void
  setUi(patch: Partial<UiState>): void        // merges, persists the layout bits to localStorage, emits 'ui'
  tempo(): Tempo; x(smp): number; fromX(px): number; snap(smp, ev?: MouseEvent): number  // alt/ctrl held = no snap
  position(): number; playing: boolean
  toggle(); play(from?); stop(); seek(smp); rewind(); toggleRecord()
  select(ids: string[]); openClip(id: string | null); focus(trackId: string | null)
  status(text: string): void                  // the status bar hint
  destroy(): void
}
```
- `'doc'` fires (coalesced with requestAnimationFrame) after any document change. Views redraw from the doc.
- `'tick'` fires every animation frame while playing, with the position. Use it for playheads, counters, meters.
- `'meters'` carries `{ master: [l, r], tracks: Map<trackId, [l, r]> }` peak levels (linear, 0..1+) about 30 times a second.
- Views never reach into each other. They talk through the Studio (state + events).

### Engine additions (Rust, `engine/`)
- `engine_meter_ptr(e)` + per-track peak meters, reported by the worklet as `{type:'meters', master:[l,r], tracks:[h,l,r,...]}`.
- `engine_set_loop(e, start: f64, end: f64, on: u32)`: a sample-accurate cycle. When playing and the position reaches
  `end`, it continues from `start` in the same block.

## 6. Conventions
- Vanilla TypeScript and the `h()` helper (`client/src/dom.ts`). No UI framework.
- Each module imports its own CSS file next to it (`import './topbar.css'`). Only the theme owns global styles.
- Keep `npm test` (client vitest) and `tsc --noEmit` passing. Add tests for pure logic (tempo, snapping, shortcuts).
- Commit only your own files, with explicit paths: `git add <paths> && git commit -m ...`. Never `git add -A`, never
  reset or checkout files you don't own.
- Screenshot your work: `node /home/claude/tools/shot.mjs <url> <out.png> [w h] [click:<selector>|wait:<ms>|eval:<js>]...`
  against the dev server on http://127.0.0.1:5173 (already running, hot reloads), and look at the result.
