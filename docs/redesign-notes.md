# Redesign working notes (Phase A results → Phase B)

What already exists, so nobody rebuilds it. Read with `docs/redesign.md`.

## Studio backbone (`client/src/studio/`)
- `studio.ts` `Studio` as in the brief, plus: UiState extras `note`, `pad`, `looperArm`, `autoOpen`; events `status`, `cpu`, `level`
  (the `'ui'` event carries the patch); members `rec` (recordingCtl), `pedal` (pedalCtl), `auto` (autoState), `remote`, `locks`,
  `remoteDrags`, `extent()`, `takeCtx()`, `addTrack(kind, name?)` (assigns colour), `newMidiClip` (project bpm/meter), `newPad`,
  `dropFiles`, `autoMenu`, `automate`, `revealAutomation`.
- `shell.ts` `mountStudio` builds topbar / browser (placeholder, mount point `browserMount`) / arrangement (+ chat) / dock / status bar.
  <900px: browser becomes a drawer, dock starts collapsed.
- `topbar.ts` old bar controls. `keys.ts` old shortcuts + `B`, `D`.
- `arrange/arrange.ts` scroller, zoom anchoring, follow-playhead, drops outside lanes. `arrange/ruler.ts` (still seconds),
  `arrange/tracks.ts` headers (rendered inside each lane row, sticky left), `arrange/lanes.ts` clips/pads/loopers/source lanes/
  automation/takes/pedal/previews/waveforms/clip menus + slim master row, `arrange/clipOps.ts` loop/pass/trim edits.
- Header click focuses the track (devices in dock); track menu is right-click. Clip opens in dock on double-click / "open in editor".
- `dock/dock.ts` tabs clip|devices, resize top edge, collapse. `dock/clipEditor.ts` piano roll / drum grid / audio panel.
  `dock/rack.ts` focused track's devices (old device cards) or master chain.
- CSS: `studio.css`, `topbar.css`, `arrange/arrange.css`, `dock/dock.css`, scoped under `.studio`.
- Meter hook: Studio re-emits `pb.onmeters` as `'meters'` = `{ master: [l, r], tracks: Map<trackId, [l, r]> }`. Nothing draws it yet.

## Engine / audio (`client/src/audio/`, `engine/`)
- Meters: `pb.onmeters` (~30/s, also stopped; silent → one zero message then none). Peaks, linear, may exceed 1.
- Loop: driven by the doc. `setLoop(doc, {start, end, on})` from `@mobdaw/shared` → bridge → `engine_set_loop`. Playhead wraps by itself.
  Suspended while a take records.
- `pb.analyser: AnalyserNode` (fftSize 2048), lazily created, for the top bar scope.

## Theme (`client/src/theme/`)
- Tokens in `tokens.css` (+ `--on-accent`, `--on-rec`, `--accent-soft`, `--rec-soft`, `--tc-0..7`, `--shadow`, `--scrim`, `--font-ui`,
  `--font-logo`, `--fs-xs 11 / --fs-sm 12 / --fs 13 / --fs-h3 15 / --fs-h2 18 / --fs-h1 24 / --fs-counter 22`, `--ease`, `--t-fast`, `--t`).
- `base.css` element rules are `:where()` (any class wins). Classes: `.on` (accent fill), `.on[data-tone=rec]`, `.btn`, `.btn.primary`,
  `.btn.danger`, `.icon-btn(.sm/.lg)`, `button.link`, `.field`, `.check`, `.popover`, `.tip`, `.value-tip`, `.seg`, `.chip` (`--c`),
  `kbd`, `.label`, `.dim`, `.faint`, `.num`, `.sr-only`, `.banner`, `dialog.modal` + `.modal-head/.modal-body/.modal-foot`.
  Do NOT use a `.rec` class for record (collides with the old timeline's `.rec`).
- `icons.ts`: `icon(name, size?, cls?)` → SVGElement, `iconHtml`, `setIcon(el, name)`, `ICON_NAMES`. Names: play pause stop record rewind
  loop metronome undo redo zoom-in zoom-out mixer arrange browser dock eye export upload folder search help settings edit plus close
  chevron-down chevron-right more grip lock keyboard trash duplicate scissors magnet power automation chat users mute speaker solo arm
  piano drum wave synth effect.
- `controls.ts`: `knob({ value, min, max, def?, scale?, label?, unit?, format?, bipolar?, size?, color?, title?, disabled?, onInput?, onChange? })`
  → `{ el, set, get, setDisabled }`; `fader({ value, orientation?, scale?, readout?, color?, title?, disabled?, onInput?, onChange? })`
  → same (size with `--fader-len`); `meter({ orientation?, stereo?, segments? })` → `{ el, push(l, r?), reset, destroy }`;
  `toggle(label|node|{icon}, { on?, title?, tone?, className?, onChange? })` → `{ el, set, get }`; `iconButton(name, title, onclick?, cls?)`;
  `segmented(options, value, onChange?)` → `{ el, set, get }`; `numberField({ value, min?, max?, step?, format?, pxPerStep?, title?, width?,
  onInput?, onChange? })` → `{ el, set, get }`; `tooltip(el, text, shortcut?)`; `showReadout/hideReadout`, `formatValue`, `meterPos`.
  Review page: `#/kit`.
- `dialog.ts`: `modal({ title, body, foot, className?, onClose? })`, `confirmModal({ title, text, action, danger? })` → Promise<boolean>.
- `client/src/cloud.ts` exports `CLOUD` (hide share/chat/presence when false). `popover()` items: `[label, run]`, `'sep'`, or rich items
  with icon / danger / disabled / shortcut.

## Content (`client/src/content/`)
- `presets.ts`: `INSTRUMENT_PRESETS` (17 finnwave, categories keys/bass/lead/pad/pluck/fx), `DRUM_KITS` (4), `EFFECT_PRESETS` (10 chains),
  `GM` key map; `applyInstrumentPreset(doc, deviceId, preset)`, `addInstrument(doc, trackId, preset)`, `addDrumKit`, `replaceDrumKit`,
  `addEffectPreset(doc, trackId, preset)`, `instrumentPreset(id)`, `drumKit(id)`, `effectPreset(id)`, `clampParams`.
- `templates.ts`: `TEMPLATES` (empty, beat, band, loopjam, demo). `demo.ts`: `buildDemo`, "Window seat", F major, 88 bpm, 32 bars.
- `compose.ts`: helpers to write content by bars/beats.

## Shared editing rules for Phase B (several engineers in one working tree)
- Your own files: use any tool. Shared hot spots (`studio/studio.ts`, `studio/shell.ts`, `studio/keys.ts`, `studio/studio.css`):
  ONLY the Edit tool with small, additive hunks (never Write the whole file), re-read just before editing, commit promptly.
- Drag-and-drop payloads between views: MIME `application/x-mobdaw` with JSON (see `studio/drops.ts`, owned by the browser engineer).
