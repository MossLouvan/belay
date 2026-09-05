# BELAY — Premium Revamp Spec ("Alpine Ledger")

Design-direction spec for the UI revamp. Supersedes nothing structurally — it **elevates** the
existing Ledger system (docs/DESIGN.md) in place. Every rule in DESIGN.md stands unless this
document explicitly amends it (amendments are marked **AMENDS §n**). All file paths are absolute.
Engineers executing an item below follow THIS spec where it conflicts with older comments in code.

---

## 1. Design thesis

**Belay is alpine safety equipment for your computer — Arc'teryx restraint carrying Petzl
hardware.** The named reference is **Arc'teryx** (granite/chalk neutrals, technical minimalism,
zero decoration, absolute confidence) with the interactive hardware — the keys, tracks, and the
one primary action — rendered in **Petzl safety-orange**: the color of the rope your life hangs
on. The chrome is calm paper ("the ledger at base camp"); the stream and terminal are dark glass
("the wall"); and the single signature element is **the rope** — the 2pt track that already
underlines every interactive label becomes a literal, consistent rope metaphor: slack and grey at
rest, loaded and orange when engaged, and *drawn* — once, at connect — as the app's hero moment
("clipping in"). Nothing blinks, nothing pulses, nothing floats: a tool you trust your life to
holds still.

---

## 2. What the screenshots get wrong today (grounded critique)

From `/tmp/belay_visuals/*.png` and the code that renders them:

1. **Three voices narrate one outage** (`screen-reconnect.png`): left header says
   `● RECONNECTING…`, right header says `● MAC · CONNECTING` (second dot, second vocabulary,
   same row), and the panel says `RECONNECTING / Could not open the screen stream — not
   connected / RETRY / RETRYING IN 4S · ATTEMPT 86`. Three dots-worth of anxiety for one fact.
   Source: the per-surface status row in `app/(tabs)/screen.tsx` (~L581–589) plus
   `src/devices/switch-link.tsx` rendering its **own** `Dot`. A premium studio ships exactly one
   sentence per fact.
2. **"ATTEMPT 86"** is the app confessing it has flailed for ten minutes. (`panel-state.tsx`
   already replaces this with the outage clock — the screenshots predate it; the spec below
   locks the clock in and bans attempt counters forever.)
3. **The dock is an orange wall** (`screen-tab-dock.png`): ten resting `accentDim` tracks —
   TOUCH PAD SCROLL BALANCED − 1.0× + / R-CLICK 2×CLICK REC CLIP TYPE — all underlined in
   washed orange. When everything is marked, nothing is. It also visually collides with the
   full-strength orange RETRY block above it: the page reads "orange everywhere = cheap."
4. **The retry button is a paint chip**: a large saturated `#FF4D00`-ish slab with squared
   corners and mono caps, floating in a black void. Premium orange is *earned and small*.
5. **Terminal breaks the system** (`terminal-tab.png`): a rounded, tinted **card** ("DISCONNECTED /
   not connected / RECONNECT" with a soft-filled button-in-a-card) in a no-card design, sitting
   on paper — while Screen narrates the identical fault on the dark glass. Same fact, two homes,
   two shapes. Also: `ERROR` on the left and `MAC · CONNECTING` on the right — the double-voice
   again, this time actively contradictory (error vs. connecting).
6. **Stray S/M/L in the Terminal header**: three underlined letters beside the title with no
   label — unguessable chrome in the app's most visible row (`terminal.tsx` ~L469–476).
7. **The stage buttons are boxed** (`KEYS` / `FULL`, top-right of the panel): bordered boxes with
   icon-over-label stacked chunks (`StageButton` in `src/screen/parts.tsx`) — the only closed
   border-boxes in the whole app, sitting on the hero surface.
8. **"No output yet."** stranded top-left of a black sea — a placeholder, not a designed state.
9. **The tab-bar badge is a pill** (`_layout.tsx` `tabBarBadge`) — pills are banned (§12).
10. **The pulsing dot** (`usePulse` on `Dot`) — founder directive: no blinking, no pulsing.

---

## 3. Tokens (paste-ready)

All changes land in `/Users/mosslouvan/projects/belay/app/src/theme.ts`. Existing verified hexes
are **kept** (they pass the WCAG worst-case discipline already documented there); the revamp
adds depth roles, retires pulse motion, and re-grounds the naming in the alpine identity.
Re-run the contrast script in docs/DESIGN-TOKENS.md §9 for every NEW hex before merging.

### 3.1 Color — light, "Chalk" (was "paper")

| Token | Hex | Status | Use |
|---|---|---|---|
| `bg` | `#EAE8E4` | keep | Chalk ground. |
| `surface` | `#F2F1EE` | keep | Inputs only. |
| `surfaceAlt` | `#E1DED9` | keep | Recessed: keys, meter tracks, pressed rows. |
| `sheet` | `#F4F3F0` | **NEW** | The sheet slab. One perceptible step off `bg`, so a raised modal reads as material, not as the page folding over itself. |
| `border` | `#C8C4BD` | keep | Hairlines. |
| `borderStrong` | `#8F8A82` | keep | Emphasis rules, focus pairing. |
| `trackRest` | `#B3AEA5` | **NEW** | **The rope at rest.** Resting 2pt track under interactive labels. Neutral granite, NOT orange — replaces `accentDim` in that role. ≥3:1 vs bg not required (it pairs with the label text which carries meaning), but it clears visibility on all three surfaces. |
| `text` | `#161513` | keep | Basalt ink. |
| `textDim` | `#4F4B45` | keep | |
| `textFaint` | `#615C55` | keep | |
| `accent` | `#B03700` | keep | Rope orange, text-safe. |
| `accentGraphic` | `#DE4400` | keep | Rope orange, marks ≥3pt (loaded track, meter fill, live cursor block). |
| `accentPress` | `#8F2D00` | **NEW** | Solid primary button fill while pressed (fills darken under load; text still uses `pressOpacity`). |
| `accentDim` | `rgba(176,55,0,0.28)` | keep, narrowed | Disabled primary fills ONLY. No longer the resting track (see `trackRest`). |
| `good / warn / bad` | `#0B6040` / `#754C04` / `#A82028` | keep | |
| `machine` | `#0C0B0A` | keep | The wall. Both themes. |
| `machineLine` | `rgba(236,234,230,0.10)` | **NEW** | Hairlines ON the glass (HUD separators, terminal gutter) — paper `border` never touches the machine surface. |
| `onMachine / onMachineDim` | `#ECEAE6` / `#A9A49C` | keep | |
| `contour` | `rgba(22,21,19,0.045)` | **NEW** | Topographic garnish ink (see §6.6). Decorative only, never carries meaning, hidden from a11y. |
| `onAccent / onDanger` | `#FFFFFF` / `#FFFFFF` | keep | |
| soft fills + `on*Soft` | keep all | keep | |
| `overlay` | `rgba(22,21,19,0.40)` | keep | |
| `skeleton` | `#DBD8D2` | keep | |

### 3.2 Color — dark, "Basalt" (was "ink")

| Token | Hex | Status |
|---|---|---|
| `bg` | `#121110` | keep |
| `surface` | `#1A1917` | keep |
| `surfaceAlt` | `#232120` | keep |
| `sheet` | `#1C1B19` | **NEW** |
| `border` | `#2E2C29` | keep |
| `borderStrong` | `#4A4741` | keep |
| `trackRest` | `#403D38` | **NEW** |
| `text / textDim / textFaint` | `#ECEAE6` / `#A9A49C` / `#928D84` | keep |
| `accent` | `#FF5C1A` | keep |
| `accentGraphic` | `#FF4D00` | keep |
| `accentPress` | `#E04300` | **NEW** |
| `accentDim` | `rgba(255,92,26,0.30)` | keep, narrowed to disabled fills |
| `good / warn / bad` | `#3DDC97` / `#F7B32B` / `#FF7A70` | keep |
| `machine` | `#0C0B0A` | keep |
| `machineLine` | `rgba(236,234,230,0.10)` | **NEW** |
| `contour` | `rgba(236,234,230,0.045)` | **NEW** |
| everything else | keep | keep |

### 3.3 Type

The scale in `theme.ts` is right and stays byte-for-byte (`display 40/42/900/−1.5 UPPER`,
`title 28/32/900/−0.6 UPPER`, `label 11/14/mono/+1.5 UPPER`, etc.). Two refinements:

- **`numeral` gains `fontVariant: ['tabular-nums']`** everywhere it isn't already (it is — keep),
  and every live counter (fps, outage clock, zoom) must use `label`/`micro`/`mono` with
  `fontVariant: ['tabular-nums']` added, so ticking values never jitter horizontally. Add
  `tabular-nums` to the `mono`, `monoSmall`, `label`, and `micro` variants in `theme.ts` — mono
  faces are already fixed-pitch so this is free, and it future-proofs the custom-font swap.
- **Named upgrade path unchanged** (Archivo Black / Space Mono, DESIGN.md §4.1) — do not bundle
  fonts in this revamp.

### 3.4 Spacing, radii, rules

Unchanged and re-affirmed: space scale `0/4/8/12/16/24/32/48`; page margin 20pt; row height
52pt; radii 2pt standard / 4pt keys only; hairline `StyleSheet.hairlineWidth` + 2pt emphasis
only. **AMENDS §6:** one additional sanctioned vertical rule — the **anchor rule**: the 2pt
status-colored left rule on a `Banner` (already implemented in `feedback.tsx`) is officially the
"anchor" mark and is the ONLY vertical emphasis rule allowed outside ledger cells.

### 3.5 Motion — "still is premium"

**Founder directive: nothing pulses or blinks. Ever.** Replace `motion` in `theme.ts`:

```ts
export const motion = Object.freeze({
  instant: 0,
  fast: 120,   // selection flips, track ignition, dot crossfade
  base: 180,   // presses, fades, screen-entry stagger step
  slow: 240,   // sheet slide; ceiling for ALL UI motion…
  draw: 400,   // …except the one sanctioned hero: the clip-in rope draw (§6.6)
  pressOpacity: 0.55,          // text/label press feedback (unchanged)
  /** @deprecated pulses are banned — pinned so usePulse degrades to steady. */
  pulse: 0,
  /** @deprecated blinking is banned — the cursor is a steady block. */
  blink: 0,
  pressScale: 1,               // unchanged, dead
  spring: Object.freeze({ damping: 18, stiffness: 240, mass: 0.6 }), // unchanged, dead
});
export const easing = Object.freeze({
  // Standard decelerate — every entrance, fade, slide.
  standard: Easing.bezier(0.2, 0, 0, 1),
  // Accelerate — exits only (sheet down, HUD hide).
  exit: Easing.bezier(0.3, 0, 0.8, 0.15),
  // Linear — clocks and progress only (outage clock, rope draw).
  linear: Easing.linear,
});
```

The motion **language** (specific transitions):

- **Screen entry (tab switch):** content group fades 0→1 over `base` with an 8pt upward settle,
  easing `standard`. No stagger cascade — one group, one move. Reduced motion: fade only.
- **Sheet presentation:** slide 8pt + fade over `slow` in / `fast` out with `exit` easing
  (current `sheet.tsx` behavior, plus the easing curves).
- **Status change (the calm replacement for pulsing):** state is *shape + color*, animated once:
  - **transitioning** (connecting/reconnecting) = a **hollow ring** (2pt stroke, status color);
  - **steady** (live/offline/fault) = a **filled dot**.
  - On transition→steady the ring *fills* (inner disc fades in over `fast`); color crossfades
    over `fast`. That single 120ms fill is the entire "we connected" motion at the dot level.
    Proof-of-life during long waits is **text, not motion**: the outage clock
    (`STILL TRYING · 9M`, `src/screen/retry.ts`) ticking each second in tabular figures.
- **Key/track presses ("the rope takes load"):** on press-in of any `TrackLabel`/dock key, its
  track snaps to `accentGraphic` and the label to `text`; on release without state change it
  relaxes back over `fast`. A key that *arms* something (R-CLICK, REC) stays lit. This makes
  every key feel mechanical and alive with zero idle animation. Haptic: `selection` (already
  wired via `hapticTone` in `dock.tsx`).
- **Terminal cursor:** steady block in `accentGraphic`, no blink. While output is streaming the
  block sits at the write position; when idle it dims to `onMachineDim`. Activity reads from the
  text moving, not from flashing.
- **The clip-in (hero, §6.6):** the only `draw`-length animation in the app.
- **Reduced motion:** all translations become fades, durations halve, the clip-in becomes a
  crossfade. (Ban on pulse means there is nothing left to freeze.)

---

## 4. The one-voice status system

**The single most important fix in this revamp.** New invariant, app-wide:

> **One dot per screen.** A screen renders exactly one status mark, in the header status line,
> and exactly one prose narration of any fault, on the machine glass (or, for glass-less tabs,
> in the page's one Banner). Header = *state word*; glass = *story + way forward*. Nothing else
> may restate the link.

Concretely (files: `src/ui/connection-view.ts`, `src/ui/connection-status.tsx`,
`src/devices/switch-link.tsx`, all five tabs):

- `describeConnection` grows into `describeSurface(connPhase, surfacePhase, extras)` — a pure
  merge with precedence **link-down beats surface-state** (if the app-wide link is
  `connecting`/`unreachable`, the surface says that; a surface may not claim `ERROR` while the
  link says `CONNECTING` — the contradiction in `terminal-tab.png` becomes unrepresentable).
  Output: `{ ring: boolean; status: Status; word: string; detail?: string }`.
- **Vocabulary, total and closed:** `LIVE` · `OPENING` · `RECONNECTING` · `OFFLINE` ·
  `SHELL ENDED` · `NOT PAIRED`. Detail is appended data, never a second state:
  `LIVE · 24 FPS · LAN`, `RECONNECTING · 45S`, `LIVE · PTY`.
- **`SwitchComputerLink` loses its `Dot`** (it currently renders one — that is the second dot in
  every screenshot). It keeps its tracked label(s): `MACBOOK · LAN` and the `⇄ MAC MINI` quick
  switch. The machine's health is already spoken by the screen's one dot; the link is a *place*,
  not a status.
- **Header anatomy, fixed on all five tabs** (already close in code; make identical):

  ```
  MACBOOK-AIR                                  ⋯      title 28/900 + trailing overflow
  ◍ RECONNECTING · 45S            MACBOOK · LAN ⇄     ONE ring/dot + word + detail; tracked
  ──────────────────────────────────────────────      machine link trailing; full-bleed rule
  ```

  On the Screen tab the title is the machine name (it already is); on Terminal/Files/System/
  Agent the title is the surface name and the machine lives only in the trailing link — the
  machine name never appears twice in one header.

---

## 5. Component redesigns (before → after)

### 5.1 Tab header (all five tabs)

- **Before:** two status rows fighting (screenshots 1–3), S/M/L stray in Terminal, `⋯` present
  on Screen but not the others consistently.
- **After:** the fixed anatomy of §4 on every tab. The trailing slot in the *title* row is always
  the overflow `⋯` (sanctioned bare glyph) and nothing else — Terminal's S/M/L moves into the
  terminal key bar as an `Aa` key cycling S→M→L (visible, labelled, next to the other terminal
  controls where text size belongs; the current segmented control dies from the header).
  Files' item count stays as title suffix (`FILES · 92`, mono) per DESIGN.md §7.2.

### 5.2 Connection status primitive

- **Before:** `ConnectionStatus` = Dot + Label; separately each tab hand-rolls its own left
  status row; `Dot` pulses.
- **After:** one `SurfaceStatus` component (evolve `connection-status.tsx`) rendering
  ring-or-dot + word + detail + trailing machine link, fed by `describeSurface`. `Dot` gains
  `ring?: boolean` and **loses `pulse`** (prop deprecated, ignored). `usePulse` in
  `src/ui/motion.ts` is gutted to return a static value (so stray callers go still, not broken).

### 5.3 Control dock (the keys — founder's favorite; keep, sharpen)

File: `src/screen/dock.tsx` + `src/ui/track-label.tsx` / `track.ts`.

- **Before:** two rows, every key underlined in washed orange (`accentDim` resting tracks);
  BALANCED quality key reads as a fourth pointer mode at a glance; `−  1.0×  +` spread wide.
- **After — same keys, quieter rope:**
  - Resting track color → **`trackRest`** (neutral granite). Selected/armed track →
    `accentGraphic`. Press-in ignition per §3.5. Result: the dock reads as machined hardware —
    a row of grey-slotted keys with exactly the *engaged* ones glowing orange. The one-glance
    rule survives (marked = interactive, DESIGN.md §11.1) — the mark is the affordance, not
    the color. **AMENDS §11.1** accordingly.
  - The TOUCH/PAD/SCROLL trio keeps its abutted continuous track (three-position switch — good,
    keep exactly as coded). The zoom cluster `BALANCED − 1.0× +` also abuts (already coded) but
    gains a **hairline vertical separator** (4pt inset, `border`) between the mode trio and the
    picture cluster so the two instruments never read as one — this replaces the ambiguous gap.
  - Key rhythm: every key stays ≥44pt with `xxs` horizontal padding; the two rows get `xxs`
    vertical separation (currently rows touch); dock top keeps its full-bleed hairline.
  - Fullscreen floating dock: unchanged mechanics; scrim chrome per `HUD`, but the border box
    around the floating dock drops its `borderWidth` — scrim + hairline **top rule only**.

### 5.4 Bottom tab bar

File: `app/(tabs)/_layout.tsx`.

- **Before:** correct bones (page-surface bar, hairline top rule, stroke glyphs, mono labels) but
  a default **pill** badge, and selection is color-only.
- **After:** keep bones. Badge → a 14pt square (2pt radius) in `accent` with `onAccent` mono 10
  count — the "carabiner gate" mark, not a pill. Selection adds a 12pt-wide, 2pt `accentGraphic`
  track centered under the active item's label (the rope again — the same selection language as
  everywhere else), crossfading position-less (fade out old, fade in new, `fast`; no slide, the
  bar holds still). Active tint stays `accent`, inactive `textDim`.

### 5.5 Machine panel + empty/loading/error states

Files: `src/screen/panel-state.tsx` (Screen — already the right anatomy), `app/(tabs)/terminal.tsx`.

- **Before:** Screen's outage is on the glass (good, current code) but the screenshots' triple
  narration must be finished off; Terminal's outage is a tinted card on paper (bad).
- **After — "faults live on the glass":** any tab that owns a machine panel narrates its faults
  *inside* the panel with the fixed §11.4 anatomy: STATE NAME (`label`) → observed fact
  (`body`, guesses labelled) → one accent action → proof-of-life clock. Terminal's
  `Disconnected/Shell exited` Banner **dies**; the transcript panel renders the same
  `PanelState`-style interior (extract the interior into a shared
  `src/ui/glass-state.tsx` so Screen and Terminal render one component). The `RECONNECT` verb
  becomes `Retry` (one verb per action, §11.3). The pipe-mode advisory Banner stays on paper —
  it is advice, not a fault — restyled per §5.8.
- The primary action inside glass states: not the giant slab from the screenshots — a compact
  solid-accent button, `label` type, `sm` height (36pt visual in a 44pt target), auto width
  + `lg` horizontal padding. Orange is small, dense, and singular.
- **"No output yet." solved:** the empty (non-fault) terminal shows the §11.4 empty anatomy,
  centered on the glass: `READY` (label, onMachineDim) / one `body` line: "Commands you run
  appear here." / proof line with the prompt hint `>` in mono. Plus the contour garnish (§6.6).
- **Attempt counters are banned** (§11.4 addendum): duration since outage only, via
  `retryPhrase`.

### 5.6 Stage chrome (KEYS / FULL and the HUD)

File: `src/screen/parts.tsx` (`StageButton`).

- **Before:** two bordered boxes with stacked icon-over-label floating on the picture.
- **After:** `StageButton` loses its border box: HUD scrim fill (keep), radius 2, **no border**,
  and the glyph+label go **inline on one row** (glyph 14pt, `micro` label) so each control is a
  low, quiet strip, not a crate. Active state = label/glyph in `accent` + a 2pt bottom track
  inside the strip (the rope, again). The pair top-right aligns to an 8pt inset grid. They
  participate in the existing auto-hide (`useAutoHide`) — fade out over `base` with `exit`
  easing after the idle timeout, any stage touch brings them back at `fast`.

### 5.7 Sheets / modals

File: `src/ui/sheet.tsx`.

- **Before:** correct (slab, hairline, 8pt slide, drag rule) but the slab is `bg` — it reads as
  the page folding, and on dark it disappears against the page.
- **After:** slab fill → **`sheet`** token; top hairline stays; the drag affordance (32×2
  `borderStrong` rule) stays — it already reads as a quiet anchor mark. Title row: `label` dim
  (keep). Add the easing curves from §3.5. Nothing else — sheets are already premium here.

### 5.8 Banner (advisories only)

File: `src/ui/feedback.tsx`.

- **Before:** soft fill + 2pt left anchor rule + radius — but inset by margins it reads as a card
  (the Terminal screenshot).
- **After:** Banner becomes **full-bleed** (margin-to-margin, no horizontal margins, radius 0),
  hairline above and below, soft fill, the 2pt anchor rule on the left edge. A band of the page,
  not a box on it. Its `action` becomes a `TrackLabel` (tracked text button) instead of a
  soft `Button` — fills within fills die. Callers (`terminal.tsx`, `files.tsx`, `system.tsx`)
  drop their `marginHorizontal` styles. Banners are for *advisories* (pipe mode, degraded data);
  faults go to the glass (§5.5) or the connect flow.

### 5.9 Connect + pairing flow (the hero surface)

Files: `app/index.tsx`, `src/connect/*` (brand.tsx, host-step, pair-step, onboarding).

- **Before (from code):** functionally strong (diagnosis, dead-end detection, scan) — visually a
  form.
- **After:** this is the app's front door and gets the signature treatment (§6.6): the topo
  ground, the `BELAY` display brand block, the clip-in animation on success. Structure:
  `BELAY` (`display` 40/900) over one `label` line `REMOTE BELAY FOR YOUR DEV MACHINE`; the
  address input as the page's only `surface` fill; `SCAN CODE` and `CONNECT` per button rules;
  the 6-digit code step keeps its mono cells. Diagnosis output uses the §11.4 anatomy verbatim.
  Success: the clip-in plays (§6.6), then the tabs take over (existing `SUCCESS_DWELL_MS` 600ms
  accommodates the 400ms draw + 120ms fill + settle).

### 5.10 Buttons & inputs

File: `src/ui/button.tsx`, `src/ui/input.tsx`.

- Solid primary: fill `accent` → **`accentPress` while pressed** (fills darken under load;
  remove opacity-ghosting on solid fills — opacity feedback stays for text/label/ghost
  variants). Height discipline: `sm` 36 / `md` 44; radius 2; `label` type. One solid accent
  button per screen (unchanged law).
- Ghost/text buttons: all become `TrackLabel` speakers (most already are).
- Inputs: `surface` fill, hairline `border`, radius 2, focus = hairline swaps to
  `focus` + 2pt bottom track in `accentGraphic` (the rope under the caret — signature detail,
  cheap to build).

---

## 6. The alpine identity — where it shows up (and where it must not)

The reference is **Arc'teryx-grade technical minimalism**; the motifs are used the way Petzl
prints on hardware: sparingly, functionally, machined. **Kitsch test:** if a motif would look
wrong laser-etched on a belay device, it does not ship.

1. **Rope-orange accent** — already in the palette (`#B03700`/`#FF5C1A`). Now scarcer (dock
   tracks went granite), so where it appears it *means* engaged/primary/live.
2. **Granite/chalk/basalt neutrals** — the existing palettes, re-named in the docs (chalk ground,
   granite tracks, basalt ink/glass). No new hues; no blue, ever.
3. **The rope as structure** — the 2pt track: rest = slack (granite `trackRest`), active/armed =
   loaded (`accentGraphic`), pressed = takes load instantly (§3.5). One metaphor, one primitive
   (`track-label.tsx`), everywhere.
4. **The anchor** — the Banner's 2pt left rule; the sheet's 32×2 drag rule. Already built;
   named, kept, never multiplied.
5. **The carabiner gate** — the square 2pt-radius badge on the Agent tab (§5.4). That's the
   entire icon budget for the metaphor; no carabiner illustrations anywhere.
6. **Topographic contours + the clip-in (the hero moment).**

### 6.6 Signature: the topo ground and the clip-in

- **Topo contours** (`contour` token): 3–4 concentric, hand-offset contour lines (SVG paths or
  nested `View` borders, hairline weight) at ~4.5% ink. Allowed in exactly three places:
  the **connect screen** background (replacing DESIGN.md §1's corner-cross allowance — AMENDS),
  the **glass empty states** (behind the centered §11.4 anatomy, drawn in `machineLine`), and
  the **My Computers empty state**. Never behind data, never on paper sections, always
  `accessibilityElementsHidden`. This is the "beautiful empty state": emptiness rendered as
  unclimbed terrain.
- **The clip-in** (connect success, the app's one flourish): a 2pt `accentGraphic` line draws
  left-margin → right-margin under the machine's name (`draw` 400ms, `linear`), the hollow ring
  at its left end *fills* (`fast` 120ms) as the line completes, a single firm `medium` haptic
  lands, and the status line settles to `● LIVE`. The rope is fixed; you are on belay. The same
  micro-form (track ignition + ring fill, no draw) plays at `fast` whenever a dropped stream
  comes back — reconnection feels like the same hardware catching you. Reduced motion:
  crossfade + haptic only.

---

## 7. Consistency rules (each with the law that prevents recurrence)

| # | Inconsistency today | The one rule |
|---|---|---|
| 1 | Screen narrates faults on glass; Terminal uses a paper card (`terminal-tab.png`) | **Faults live on the glass.** A surface with a machine panel narrates its own outage only inside that panel, via the shared `glass-state` component. Banner = advisory only. |
| 2 | Two dots + two vocabularies per header (all screenshots) | **One dot per screen.** Only `SurfaceStatus` may render a status mark; `describeSurface` is the only source of state words. `SwitchComputerLink` is a place, not a status — it has no Dot. |
| 3 | Stray S/M/L in Terminal header; `⋯` placement varies | **The title row's trailing slot holds `⋯` or nothing.** Every other control lives in the surface's own chrome (dock, key bar, sheet). |
| 4 | Orange resting tracks vs orange selection vs orange button all shouting (`screen-tab-dock.png`) | **Orange means engaged.** Resting affordance marks are `trackRest`; `accent`/`accentGraphic` appear only on selected, armed, primary, or live elements. |
| 5 | Pulsing dot here, static there; blinking cursor | **Nothing pulses.** State is shape (ring/fill) + color, animated once per change; waiting is proven by a ticking clock, not by motion. |
| 6 | Pill badge on the tab bar vs banned pills | **If it's rounder than 4pt it doesn't ship.** (Existing §12, now with zero exceptions in code.) |
| 7 | "RECONNECT" vs "RETRY" vs "Try again" | **One verb per action** (§11.3): Retry, everywhere, enforced by copy living in `retry.ts`/`glass-state` rather than call sites. |
| 8 | Attempt counters vs outage clocks | **Duration, never attempts.** All retry copy flows through `retryPhrase`. |

---

## 8. Execution plan — ordered, conflict-grouped

Groups are file-disjoint; items within a group are sequential. **G1 merges first; G2–G3 next;
everything after is parallel.** Do not start G4–G10 until G1–G3 land (they consume the new
tokens/primitives). No item touches another group's files.

### G1 — Token layer (first, everything inherits)
1. **theme.ts: color roles** — add `sheet`, `trackRest`, `accentPress`, `machineLine`,
   `contour` to both palettes + `Palette` interface; narrow `accentDim` doc-comment to
   disabled-fills-only. Run the contrast verifier for new hexes.
   *Files:* `app/src/theme.ts`. *(docs update in G11.)*
2. **theme.ts: motion + easing** — pin `pulse`/`blink` to 0 with deprecation notes, add `draw:
   400`, export the `easing` object (§3.5). Add `tabular-nums` to `label`/`micro`/`mono`/
   `monoSmall` variants.
   *Files:* `app/src/theme.ts`.

### G2 — Shared primitives
3. **motion.ts: kill pulses** — `usePulse` returns a static `Animated.Value(1)` (deprecated);
   add `useEntrance` (fade + 8pt settle) and export easing-aware `useToggleAnimation`.
   *Files:* `app/src/ui/motion.ts`.
4. **feedback.tsx: Dot → ring/dot** — add `ring` prop (2pt stroke rendering), drop `pulse`
   behavior (accept + ignore prop), 120ms fill/crossfade on state change.
   *Files:* `app/src/ui/feedback.tsx`.
5. **feedback.tsx: Banner full-bleed** — radius 0, no default insets, hairlines above/below,
   action becomes tracked text (§5.8).
   *Files:* `app/src/ui/feedback.tsx` (same file as #4 — same agent, sequential).
6. **track.ts / track-label.tsx: rope inks** — resting ink `trackRest`; press-in ignition to
   `accentGraphic` + relax on release (§3.5); disabled dims whole.
   *Files:* `app/src/ui/track.ts`, `app/src/ui/track-label.tsx`.
7. **button.tsx: pressed fills** — solid variants use `accentPress`/darkened `bad` on press
   instead of opacity; size discipline audit.
   *Files:* `app/src/ui/button.tsx`.
8. **input.tsx: focus rope** — focus = `focus` hairline + 2pt `accentGraphic` bottom track.
   *Files:* `app/src/ui/input.tsx`.
9. **sheet.tsx: sheet token + easing** — slab → `colors.sheet`; wire `easing.standard/exit`.
   *Files:* `app/src/ui/sheet.tsx`.
10. **NEW `glass-state.tsx`** — extract the §11.4 interior from `panel-state.tsx` into
    `app/src/ui/glass-state.tsx` (state name / fact / one compact accent action / proof line /
    optional contour garnish), theme-locked to the dark ink per the machine-panel rule.
    *Files:* `app/src/ui/glass-state.tsx` (new), `app/src/ui/index.tsx` (export).
11. **NEW `contours.tsx`** — the decorative topo component (`app/src/ui/contours.tsx`),
    a11y-hidden, `contour`/`machineLine` inks, two densities (page / glass).
    *Files:* `app/src/ui/contours.tsx` (new), `app/src/ui/index.tsx` (export — same-file
    conflict with #10: same agent or sequenced).

### G3 — One-voice status
12. **connection-view.ts → describeSurface** — the merge function + closed vocabulary + ring
    flag (§4), with node tests beside it.
    *Files:* `app/src/ui/connection-view.ts` (+ its test).
13. **connection-status.tsx → SurfaceStatus** — ring/dot + word + detail + trailing slot;
    keep the old export as a shim.
    *Files:* `app/src/ui/connection-status.tsx`.
14. **switch-link.tsx: drop the Dot** — remove the second dot; label-only tracked link.
    *Files:* `app/src/devices/switch-link.tsx`.

### G4 — Screen tab
15. **screen.tsx header → SurfaceStatus** — delete the hand-rolled status row + `PHASE_LABEL`
    left/right duplication; one header per §4.
    *Files:* `app/app/(tabs)/screen.tsx`.
16. **panel-state.tsx → glass-state** — render the shared interior; verify attempt-counter copy
    is gone; add contour garnish to non-fault states.
    *Files:* `app/src/screen/panel-state.tsx`.
17. **dock.tsx: granite rope + separator** — inherits new track inks automatically; add the
    inset vertical hairline between mode trio and picture cluster; `xxs` row gap; floating dock
    drops its border box.
    *Files:* `app/src/screen/dock.tsx`.
18. **parts.tsx: StageButton restyle** — inline glyph+label strip, no border, active track,
    auto-hide fade (§5.6).
    *Files:* `app/src/screen/parts.tsx`.
19. **Clip-in on stream-live** — the `fast` track-ignition + ring-fill when `phase` reaches
    live (§6.6 micro-form), reduced-motion safe.
    *Files:* `app/app/(tabs)/screen.tsx` (sequential after #15 — same file).

### G5 — Terminal tab
20. **terminal.tsx: header + one voice** — S/M/L out of the header (state stays; control moves
    to key bar item #21); `SurfaceStatus`; delete the offline/exited Banner; keep pipe-mode
    Banner (now full-bleed automatically).
    *Files:* `app/app/(tabs)/terminal.tsx`.
21. **terminal-keys.tsx: `Aa` size key + steady cursor** — add the S/M/L cycle key to the key
    bar; cursor block steady `accentGraphic`, dim when idle, no blink.
    *Files:* `app/src/terminal-keys.tsx`, `app/src/terminal-output.tsx`.
22. **Terminal glass states** — transcript renders `glass-state` for disconnected / shell-ended /
    empty (`READY` anatomy, §5.5), `Retry` verb.
    *Files:* `app/app/(tabs)/terminal.tsx` (sequential after #20 — same file).

### G6 — Files tab
23. **files.tsx: header + Banner insets** — `SurfaceStatus`; remove Banner margins; audit rows
    against `trackRest` inheritance.
    *Files:* `app/app/(tabs)/files.tsx`, `app/src/files-row.tsx`.

### G7 — System tab
24. **system.tsx: header + meters** — `SurfaceStatus`; meter fills stay status-colored on
    `surfaceAlt` tracks; Banner insets removed; `UPDATED 2S AGO` uses tabular figures.
    *Files:* `app/app/(tabs)/system.tsx`, `app/src/system/sections.tsx`.

### G8 — Agent tab
25. **agent.tsx + session-list: header + steady dots** — `SurfaceStatus`; running-session dots
    steady (no pulse — activity is the feed moving); approval band keeps its warn-soft
    anchor-rule treatment.
    *Files:* `app/app/(tabs)/agent.tsx`, `app/src/agent/session-list.tsx`,
    `app/src/agent/needs-you-banner.tsx`.
26. **approval-card / new-project-sheet sweep** — inherit sheet token; kill any residual
    card fills/radii >4pt.
    *Files:* `app/src/agent/approval-card.tsx`, `app/src/agent/new-project-sheet.tsx`.

### G9 — Tab bar
27. **_layout.tsx: badge + selection track** — square carabiner badge; 12pt underline track with
    crossfade; no other changes.
    *Files:* `app/app/(tabs)/_layout.tsx`.

### G10 — Connect flow
28. **index.tsx + connect/*: hero pass** — topo ground via `contours.tsx`; brand block audit;
    §11.4 anatomy for diagnosis states; the full clip-in draw on success (§6.6).
    *Files:* `app/app/index.tsx`, `app/src/connect/brand.tsx`, `app/src/connect/host-step.tsx`,
    `app/src/connect/pair-step.tsx`, `app/src/connect/onboarding.tsx`.
29. **devices.tsx: My Computers pass** — rows to ledger anatomy, empty state with contour
    garnish, steady dots.
    *Files:* `app/app/devices.tsx`.

### G11 — Docs & verification (last)
30. **DESIGN.md amendments** — record the AMENDS from this spec (§3.5 motion, §6 anchor rule,
    §11.1 trackRest, §1 topo-for-crosses, one-dot law, no-pulse law, attempt-counter ban).
    *Files:* `docs/DESIGN.md`, `docs/DESIGN-TOKENS.md`.
31. **Contrast + still-motion audit** — run the DESIGN-TOKENS verifier over new hexes; grep the
    app for `usePulse`/`blink`/`pulse={true}` and confirm all still; screenshot pass against
    §2's ten findings.
    *Files:* read-only sweep + `docs/DESIGN-TOKENS.md` table.

---

*Spec authored 2026-09-03 from live screenshots in /tmp/belay_visuals/, docs/DESIGN.md, and the
current implementations in app/src/theme.ts, app/src/ui/*, app/src/screen/*, app/app/(tabs)/*.*
