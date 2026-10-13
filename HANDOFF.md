# mobdaw redesign: handoff

Overnight work (Oct 12–13, 2026) on the `redesign` branch: a rebuilt interface for the online DAW at
wrongbad.com/mobdaw, prepared for a static demo at **daw.bitcount.com**.

## Where things stand

| | |
|---|---|
| Code | branch `redesign`, 45 commits on top of `ec26a29` (the source behind wrongbad.com/mobdaw, verified against the live bundle) |
| Tests | client vitest 279/279, engine `cargo test` all pass, `tsc --noEmit` clean |
| Prebuilt site | `client/dist/` (built with `BASE_PATH=/` for daw.bitcount.com, includes the wasm engine) |
| Preview | a private claude.ai artifact (relative build); the microphone is blocked inside the artifact frame |
| AWS | **not provisioned yet.** Every `*.amazonaws.com` endpoint was blocked by this session's network policy (cloud sandbox and the VM on your Mac). See [RESOURCES.md](RESOURCES.md). |

## Deploy (one command)

Needs the AWS CLI with credentials for the account that owns the `bitcount.com` Route 53 zone.
```sh
deploy/aws/deploy.sh --skip-build      # uploads the prebuilt client/dist; first run ~5–15 min (certificate + CloudFront)
```
Without `--skip-build` it rebuilds, which needs Node and a Rust wasm32 toolchain. Teardown: `deploy/aws/teardown.sh`.
Details, IAM policy and troubleshooting: [docs/deploy-daw.bitcount.com.md](docs/deploy-daw.bitcount.com.md).
Local check with the production headers and CSP: `node deploy/aws/serve-local.mjs` (serves `client/dist`).

## What changed for users

- **Studio layout:** top bar (transport, lit bar/beat counter, tempo with tap, meter, snap, undo/redo, arrange/mix, scope),
  left browser, arrangement, bottom dock (clip editor or device rack), status bar with hints.
- **Musical grid:** project tempo and meter, bars/beats ruler, snap (bar … 1/32), loop region (cycle) that's sample-accurate
  in the engine, song markers/sections (`I`, `[` `]`, loop a section), and tempo changes that keep everything on its bar.
- **Mixer view** (`X`): channel strips with faders, pan, meters, inserts and a master strip.
- **Device rack:** hardware-style panels with knobs, presets, bypass, drag-to-reorder, and a drum kit pad panel.
- **Clip editor:** piano roll with velocity lane, quantize and transpose; a drum grid; and an audio clip panel with fades and gain.
- **Browser:** 17 synth presets, 4 drum kits, effects and 10 effect chains, and project audio. You can drag or double-click to add them.
- **Meters:** per track and master (a new engine feature), plus a master scope.
- **Playing and recording:** the computer keyboard plays instruments (`⇧K`), MIDI keyboards are supported, there is MIDI
  recording, a count-in, and friendlier recording errors.
- **Editing:** box select, copy/cut/paste/duplicate, nudge, split (now MIDI too), clip names and a clip menu.
- **Start screen:** templates (Blank, Beat, Band, Loop jam) and a built-in demo song, "Window seat", made only from the
  engine's synths.
- **Projects:** snapshots (version history, restore into a new project), installable PWA that works offline.
- **Shortcuts:** all listed under `?`.

## Decisions I made while you were away

- Static-only deployment: no Node server, so accounts, cloud projects, sharing, collaboration and chat are hidden
  (`VITE_CLOUD=1` brings them back for the server build). Projects live in the browser and move as `.mobdaw` files.
- Kept the existing engine, Yjs document schema and vanilla-TS approach; split the 2000-line timeline into `client/src/studio/`.
- Visual direction "tape-era console": warm graphite, Barlow Semi Condensed, track colours everywhere, lit amber counter.
  Brief: [docs/redesign.md](docs/redesign.md).
- Arrange/mix switch is `X` (Logic's key), not Tab, so Tab keeps working for keyboard navigation.
- Recording with an instrument track selected records MIDI; with an audio track selected it records audio.

## MIDI files

Import `.mid` files by dropping them (on empty space for new tracks, on an instrument lane for one clip) or with the browser's
"Import audio or MIDI…". Export a clip (clip menu) or the whole project (export dialog) as `.mid`. Only the first tempo
is used, and only notes come through (no controllers or pitch bend).

## Known gaps

- Two browser tabs on the same local project don't sync live (they merge on reload).
- Markers and the loop region don't rescale if the sample rate is changed (only possible with no tracks).
- With IndexedDB blocked the studio opens in memory with a banner, but the status bar still says "saved on this device".
- Long imports (10-minute WAV) use a lot of memory; fine on desktop, heavy on phones.
- Engine wasm build in this sandbox needed `-Zbuild-std` (no wasm32 std download); on a normal machine `npm run build:wasm` works.

## Where to read more

[docs/redesign.md](docs/redesign.md) (brief), [docs/redesign-notes.md](docs/redesign-notes.md) (module APIs),
[docs/engine-api.md](docs/engine-api.md) (meters and loop exports), [RESOURCES.md](RESOURCES.md) (AWS inventory).
