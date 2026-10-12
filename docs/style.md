# UI style

Notes on how the client looks. The styles live in `client/src/styles.css`.

## General

- Flat and tiled: surfaces are told apart by background hints and 1px lines. Use margin and corner radius sparingly. Where used, the radius is 5px: the timeline's tracks (tiles on a black background with a small gutter between them) and the project tiles on the home page.
- Labels are lowercase ("audio", "midi", "bypass").

## Buttons

- **No background by default.** A button is just floating text on whatever surface it sits on.
- **A background tint on hover** (`var(--line)`).
- The active / toggled-on state (`.on`) is the exception: it gets a filled background (`var(--accent)` for most toggles, `var(--danger)` for record).
- Don't give a resting button its own tint. It fights the surface behind it, especially title bars, which change colour (e.g. collapsed FX chains).
