# UI style

Notes on how the client looks. The styles live in `client/src/styles.css`.

## General

- Flat and tiled: surfaces are told apart by background hints and 1px lines. The exception is the timeline's tracks: rounded (5px) tiles on a black background with a small gutter between them.
- Labels are lowercase ("audio", "midi", "bypass").

## Buttons

- **No background by default.** A button is just floating text on whatever surface it sits on.
- **A background tint on hover** (`var(--line)`).
- The active / toggled-on state (`.on`) is the exception: it gets a filled background (`var(--accent)` for most toggles, `var(--danger)` for record).
- Don't give a resting button its own tint. It fights the surface behind it, especially title bars, which change colour (e.g. collapsed FX chains).
