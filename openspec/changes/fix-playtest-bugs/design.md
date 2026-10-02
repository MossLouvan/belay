## Ground rules for every fix agent
- Read the GitHub issue first (`gh issue view <n>`): it has repro, screenshot and likely file:line. Confirm the root cause in code before editing; fix it where all callers route through.
- Ponytail: shortest correct diff. No new deps, no new abstractions, no drive-by refactors.
- TDD: add/adjust a `*.test.mjs` (node --test) that fails before the fix where the logic is testable (models, stores, parsers). Pure layout fixes (#75 #76 #78 #91) need no unit test; state the viewport you checked in the PR.
- Must pass before PR: `cd app && npm test && npm run typecheck`; if server touched, `cd server && npm test`.
- Do not edit `tasks.md` (orchestrator ticks it). Do not touch `app/app.json`, `modules/`, or any `tether`/`TETHER_*` compat shim.
- One PR per group against `main`, title `fix(<area>): playtest bugs …`, body lists `Closes #n` per issue. No merging.

## Decisions taken by default (owner may override)
- #90: terminal session (socket, TermState, history) moves to a module-level store, same pattern as `app/src/agent/attention-store.ts`; routes stay as they are. Session ends only on explicit close, host change, or disconnect.
- #83: Forget = best-effort `api.revokeDevice` for this phone's own token (short timeout), then local removal regardless. Unreachable host → still forget locally; copy says the host will drop it on next contact is NOT promised.
- #87: host translates bare LF→CRLF for `mode: 'pipe'` only (one place, server side); pty path unchanged.
- #88: iterate by code point; wide (East Asian Wide/Fullwidth + emoji) chars advance 2 columns and wrap before if they don't fit. Small inline range table, no library.
- #67: darwin used = (active + wired + compressed) pages from `vm_stat`, cached; other OSes unchanged; fall back to freemem() on parse failure.
- #68: client compares `sha256(ownToken).slice(0, n)` to `tokenPrefix` (fix the test fixture too).
- #70/#81: one shared fix — pass `aria-selected` (web) alongside `accessibilityState` in the shared control, then reuse it in appearance-nav and mode-switch/mode-strip.
- #71: darken/lighten only the failing tokens to ≥4.5:1 (text) / ≥3:1 (large/UI); update DESIGN-TOKENS.md ratios to what ships.
- Owner request (Controls tab felt randomly placed → Parsec-style): the BelugaAvatar HUD mascot becomes the controls button. Tap reveals the dock; PanResponder drag (~6pt tap/drag threshold) moves it, it snaps to the nearest left/right edge on release, clamped to the safe area and clear of the HUD pill and recording strip; position persisted per orientation with the existing prefs helper. Its old tap (back to portrait) moves into the dock Menu. The separate Controls tab is deleted. Drag never sends input to the host. Snap/clamp maths lives in a pure tested module.
