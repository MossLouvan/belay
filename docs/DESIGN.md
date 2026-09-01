# Belay Design System — "Ledger"

Specification for the visual rebuild of the Belay app (Expo / React Native, iOS + web).
Companion file: [DESIGN-TOKENS.md](./DESIGN-TOKENS.md) holds the concrete `theme.ts` values.

**Acceptance criteria, in the owner's words:** it must look like the reference
(Swiss/editorial, no cards, no gradients, one palette, methodical placement), **and**
"everything is easy to find, and the UI and the UX are amazing." Discoverability carries
equal weight with the aesthetic. Where they conflict, §11 says which wins and why.

---

## 1. Reading the reference

The reference is a designer-portfolio landing page: warm paper-grey ground, an ultra-heavy
grotesque display face set enormous ("CREATIVE / DEVELOPER"), wide-tracked uppercase
monospace micro-labels ("ABOUT", "LOCATION: ENGLAND", "PRESS PLAY"), a single vivid
orange accent used as tiny marks (a dot, a square, a play triangle), a secondary blue dot
used once, registration-cross ornaments in the corners, and enormous negative space.
Structure comes entirely from typography, alignment and emptiness — there is not a single
card, border box, or shadow.

This is textbook International Typographic Style filtered through contemporary
editorial/brutalist web design: a mathematical grid, asymmetric flush-left composition,
sans-serif type doing all the hierarchy work, and design treated as rational
problem-solving rather than decoration (Müller-Brockmann's programme; see Sources).
The mono micro-labels and raw exposed structure are the brutalist-web layer on top.

**What translates to a 390pt phone:**

- The paper/ink palette and the single orange accent — directly.
- The uppercase mono micro-label as the universal section marker — directly, and it is
  a gift for a terminal app: the UI chrome and the terminal output become one voice.
- Heavy grotesque display type — at reduced size (40pt, not 300pt).
- The "ledger" footer pattern (`LOCATION:  ENGLAND … 14:54`) — label-left, value-right
  rows become the app's core data pattern.
- Negative space as the separator — partially (see below).

**What does not translate, and what replaces it:**

- **Acres of whitespace.** A 1512pt-wide hero can spend 60% of its area on emptiness; a
  390pt phone screen showing live stats cannot. Replacement: a strict spacing scale with
  generous-but-bounded section gaps (32pt), and hairline rules doing the separating work
  whitespace did on desktop. Emptiness is spent where it buys hierarchy (above the title,
  around the hero numeral), not sprayed everywhere.
- **Hover-revealed affordances.** There is no hover on iOS. Everything interactive must
  announce itself statically (§11).
- **Registration crosses and ornamental marks.** Pure decoration; on a utility screen they
  would read as broken UI. Dropped entirely, with one exception: the connect screen may
  use corner crosses as brand garnish because it is the one screen with room to spare.
- **The 3D blob.** No equivalent. The Screen tab's live video is the app's "hero object"
  and gets the same compositional respect instead (§9).

---

## 2. Principles

Stated so they can be applied to a screen this document never saw.

1. **The page is one surface.** Everything sits directly on the background. No
   containers, no fills behind content groups, no elevation. The only filled rectangles
   allowed are: text inputs, the terminal/video "machine panels" (§4.4), solid buttons,
   and soft status tints behind status text. If you are about to wrap something in a
   box, use a rule, a label, and space instead.
2. **Typography is the hierarchy.** Size, weight, case and tracking do the work borders
   and shadows used to do. Every screen has exactly one display-weight element; if two
   things are shouting, demote one.
3. **Mono is the voice of the machine, sans is the voice of the app.** Everything that
   comes *from* the computer — hostnames, paths, sizes, percentages, timestamps, terminal
   output, IPs — is set in mono. Everything Belay itself says — titles, buttons, prose,
   guidance — is set in the sans. This one rule makes data findable at a glance.
4. **One accent, and it must be earned.** Orange marks exactly three things: the current
   selection, the primary action, and live activity (a streaming cursor, a pulsing live
   dot). Never for decoration, never for large fills except the single primary button,
   never two accented elements of the same kind on one screen. Status (good/warn/bad)
   has its own muted colours and is not the accent.
5. **The grid is real.** Every x-position is the 20pt page margin, a column edge, or the
   right margin. Every y-gap is a value from the spacing scale. If a value is not in the
   scale, the layout is wrong, not the scale.
6. **Left edge is sacred.** Flush-left, ragged-right, like the reference. Only three
   things may right-align: values in ledger rows, numerals in tables, and trailing
   actions. Nothing is ever centred except content inside the machine panels and the
   connect screen's brand block.
7. **Density with rhythm.** Belay is a utility; it is allowed to be dense. Density is
   made legible by *repetition* — identical row heights, identical label styles,
   identical rules — not by spacing everything out.
8. **Findable beats minimal.** When restraint would hide a control someone needs, the
   control wins and the restraint loses (§11). The aesthetic bends; the UX does not.

---

## 3. Colour

One scheme, every screen. Light is "paper" (warm grey ground, near-black ink), dark is
"ink" (the same design photographed in negative — same hue temperature, same accent, same
rules). All ratios below are WCAG 2.1 relative-luminance checks, verified against the
**worst-case composited background** among { bg, surface, surfaceAlt } — same discipline
as the current `theme.ts`. Soft-fill ratios are computed for text over the fill
composited over `surfaceAlt`. Verified 2026-08-31 with the method in DESIGN-TOKENS.md.

### 3.1 Light — "paper"

| Role | Hex | Worst-case contrast | Use |
|---|---|---|---|
| `bg` | `#EAE8E4` | — | The page. Warm paper grey, from the reference. |
| `surface` | `#F2F1EE` | — | Input fields only (a slightly lifted paper). |
| `surfaceAlt` | `#E1DED9` | — | Recessed fields: key-bar keys, segmented track, pressed rows. |
| `text` | `#161513` | 13.60:1 on surfaceAlt | Ink. All primary text. |
| `textDim` | `#4F4B45` | 6.45:1 | Secondary text, ledger labels. |
| `textFaint` | `#615C55` | 4.94:1 | Tertiary: timestamps, hints, disabled-looking-but-legal. |
| `accent` | `#B03700` | 4.61:1 | Text-safe burnt orange: selected labels, links, live counters. |
| `accentGraphic` | `#E84A00` | 3.17:1 (non-text, ≥3:1 per WCAG 1.4.11) | Vivid orange for marks ≥3pt: dots, squares, the selection underline, progress fills, the streaming cursor. Never for text. |
| `good` | `#0B6040` | 5.67:1 | OK/healthy. Muted forest, not neon. |
| `warn` | `#754C04` | 5.06:1 | Degraded. |
| `bad` | `#A82028` | 5.39:1 | Failing/destructive. |
| `onAccent` | `#FFFFFF` | 5.9:1 on accent | Text on the solid accent button. |
| `onDanger` | `#FFFFFF` | 5.6:1 on bad | Text on solid destructive button. |
| `border` | `#C8C4BD` | 1.42:1 vs bg (non-text hairline) | Hairline rules. Deliberately quiet. |
| `borderStrong` | `#8F8A82` | — | Emphasis rules (§6) and input focus outlines pair with accent. |
| soft fills | status colour at **10% alpha** | — | Behind status text only. |
| `onAccentSoft` | `#9A3000` | 4.85:1 composited | Text on accentSoft. |
| `onGoodSoft` | `#095538` | 5.66:1 | |
| `onWarnSoft` | `#6D4603` | 5.36:1 | |
| `onBadSoft` | `#961E25` | 5.33:1 | |

### 3.2 Dark — "ink"

| Role | Hex | Worst-case contrast | Use |
|---|---|---|---|
| `bg` | `#121110` | — | Warm near-black, not blue-black. |
| `surface` | `#1A1917` | — | Inputs. |
| `surfaceAlt` | `#232120` | — | Recessed fields. |
| `text` | `#ECEAE6` | 13.34:1 | Paper on ink. |
| `textDim` | `#A9A49C` | 6.47:1 | |
| `textFaint` | `#928D84` | 4.86:1 | |
| `accent` | `#FF5C1A` | 5.19:1 | The reference orange survives untamed in dark. |
| `accentGraphic` | `#FF4D00` | 4.82:1 (non-text) | Marks. |
| `good` | `#3DDC97` | 9.07:1 | Kept from current palette (passes, known-good). |
| `warn` | `#F7B32B` | 8.73:1 | Kept. |
| `bad` | `#FF7A70` | 6.31:1 | Slightly lifted from current `#FF6B6B`. |
| `onAccent` | `#121110` | 6.1:1 on accent | Ink text on orange. |
| `onDanger` | `#121110` | 6.9:1 | |
| `border` | `#2E2C29` | — | Hairlines. |
| `borderStrong` | `#4A4741` | — | |
| soft fills | status colour at **14% alpha** | — | |
| `onAccentSoft` | `#FF7A3D` | 5.17:1 composited | |
| `onGoodSoft` | `#3DDC97` | 6.77:1 | |
| `onWarnSoft` | `#F7B32B` | 6.51:1 | |
| `onBadSoft` | `#FF7A70` | 5.13:1 | |

### 3.3 What earns the accent

Exactly these, nothing else:

- The **selected** state: active tab label, active segmented option, selected sort key.
  One selection system per screen.
- The **primary action**: at most one solid accent button per screen ("Connect",
  "Run", "Approve"). Everything else is a text button or hairline-outlined button in ink.
- **Live activity**: the pulsing live dot, the streaming-output cursor, an in-flight
  transfer. When activity stops, the accent leaves.
- **Errors do not get the accent.** Errors are `bad`. If everything urgent were orange,
  nothing would be.

### 3.4 Machine panels

The Screen tab's video and the Terminal render inside a **machine panel**: a true-dark
rectangle (`machine: #0C0B0A`) in *both* themes, full-bleed to the screen edges (no side
margins), square corners, separated from the page by a single hairline above and below —
never a border box. Text on it uses `onMachine #ECEAE6` (16.4:1) and `onMachineDim
#A9A49C` (7.9:1); accent on it is `#FF5C1A` (6.4:1). Rationale: a live desktop stream and
a pty are windows into the computer, not UI surfaces; keeping them physically dark in both
themes makes them read as *glass*, makes the light theme's contrast with the paper page
into a compositional feature (the reference's black-type-on-paper move), and spares the
terminal from an ANSI-on-light-background palette nobody maintains.

---

## 4. Type

### 4.1 The face decision: system fonts, no `expo-font` — for v1

Recommendation: **do not bundle custom fonts yet.**

- The display style uses the system sans at weight `'900'` — SF Pro Black on iOS, Roboto
  900 on Android, `-apple-system / Helvetica Neue / Arial` heavy weights on web. SF Pro
  Black with tight tracking is genuinely close to the reference's heavy grotesque at
  phone sizes; the resemblance gap only opens at poster sizes we never use.
- The mono style uses the platform mono the app already ships: Menlo on iOS,
  `ui-monospace / SFMono-Regular / Menlo / Consolas` on web, `monospace` on Android.
  Wide-tracked uppercase Menlo at 10–11pt is a convincing match for the reference's
  micro-labels, and Menlo is a proven terminal face — which matters because our terminal
  is real.
- Honest costs of this choice: web and Android renderings will be *good* but not
  *identical* to iOS; Roboto Black is squarer than SF Black. And no system face has the
  reference's slightly-quirky mono personality.
- Why it still wins: zero bundle weight, zero licence work, zero `expo-font` loading
  states, Dynamic Type keeps working natively, and per §2 the aesthetic here is carried
  by layout, rules and tracking more than by the exact cut of the font.
- **Named upgrade path** if the owner wants closer fidelity later: bundle exactly two
  OFL families via `expo-font` — *Archivo Black* (display) and *Space Mono* (labels
  only, terminal stays Menlo). ~350KB, licence-clean. This is a token-level swap
  (`font.display`, `font.mono` in DESIGN-TOKENS.md) touching no component code. Decide
  after seeing v1 on device.

### 4.2 The scale

Eight steps. Sizes in pt; letter-spacing in pt (RN units). All sans variants use the
system face; mono variants use `font.mono`. Numerals in stats and tables always set
`fontVariant: ['tabular-nums']`.

| Variant | Face | Size/Line | Weight | Tracking | Case | Role |
|---|---|---|---|---|---|---|
| `display` | sans | 40/42 | 900 | −1.5 | UPPER | One per app-moment: connect-screen brand, full-screen empty states. |
| `title` | sans | 28/32 | 900 | −0.6 | UPPER | The screen title. Exactly one per screen. |
| `heading` | sans | 19/24 | 800 | −0.3 | sentence | Sub-screen headings (rare). |
| `subheading` | sans | 16/21 | 700 | 0 | sentence | Row primary text that must carry weight. |
| `body` | sans | 15/21 | 400 | 0 | sentence | Prose, guidance, descriptions. |
| `bodyStrong` | sans | 15/21 | 600 | 0 | sentence | Emphasis inside body. |
| `caption` | sans | 13/17 | 400 | 0 | sentence | Secondary prose. |
| `numeral` | sans | 34/38 | 800 | −0.5, tabular | — | Hero stats: "39%". |
| `label` | mono | 11/14 | 400 | +1.5 | UPPER | **The micro-label.** Section markers, ledger keys, tab names, button labels on quiet buttons. |
| `micro` | mono | 10/13 | 400 | +1.2 | UPPER | Sub-labels inside dense chrome (key bar hints, timestamps in feeds). |
| `mono` | mono | 13/19 | 400 | 0 | — | Data values, paths, terminal at M size. |
| `monoSmall` | mono | 11/16 | 0 | 0 | — | Terminal S size, dense data. |

Rationale for values: 15/21 body is the current app's proven readable size at 390pt;
uppercase micro-labels get +1.5pt tracking on 11pt ≈ 13% — inside the 5–12%+ range
typographic practice prescribes for letterspaced caps (Butterick); display tracking is
negative because heavy grotesques at large sizes need optical tightening (the reference
does the same). Line-heights are size × ~1.4 for prose and tighter (~1.05–1.15) for
display sizes, per standard editorial practice.

### 4.3 The micro-label style (load-bearing)

`label` is the single most-used variant in the system. It marks: every section
("CPU", "MEMORY", "SESSIONS", "UPDATE RATE"), every ledger key ("UPTIME:", "OS:"),
the tab bar, quiet buttons ("SCAN CODE"), and status words ("LIVE", "ERROR",
"WAITING"). It is always mono, always uppercase, always tracked, and — crucially —
usually `textDim`, going `text` when its section is active and `accent` only when
selected. Because it is everywhere, it must never be bold and never larger than 11pt,
or the page turns into a shouting match.

### 4.4 Dynamic Type

Keep the existing per-variant `maxFontSizeMultiplier` discipline: prose scales far
(1.8×), display/title/label are capped (1.2–1.3×) because they live in fixed chrome.
Machine-panel content (terminal, video overlay chrome) is exempt from Dynamic Type —
it already has its own S/M/L size control.

---

## 5. Spacing and grid

### 5.1 The scale

Strict 4pt base. Keys keep their current names so migration is mechanical:

`none 0 · xxs 4 · xs 8 · sm 12 · md 16 · lg 24 · xl 32 · xxl 48`

If a gap is not one of these, it is a bug. (Current values 2/6/10/34 are retired.)

### 5.2 The grid

- **Page margin: 20pt** both sides (`layout.margin`). On 390pt that leaves a 350pt
  content column. Max content width 680pt, centred, on web/tablet.
- **One column** by default. The second alignment edge is the **right margin**, used by
  ledger values and trailing actions. A true two-column split (50/50 on the gutter) is
  allowed only for paired ledger cells ("UPTIME | OS" style).
- **Full-bleed elements** — hairline rules under screen headers, machine panels, and
  list separators — run margin-to-margin edge-to-edge (rules span the full width
  *including* margins; see §6). Everything else respects the margin.
- **Vertical rhythm:** rows in a list are a uniform 52pt minimum (≥44pt touch target
  plus breathing room); section gaps are `xl` (32); intra-section gaps are `sm` (12);
  label-to-content gaps are `xs` (8).
- The screen header block is fixed anatomy on every tab: safe-area top + `md`, then
  `title`, then a `label` status line (live dot + state + timestamp), then `md`, then a
  full-bleed hairline. Same on all five tabs, so the eye always knows where it is.

---

## 6. Rules for rules (hairlines)

Hairlines are the skeleton that replaces every card border. They are structural, so they
follow strict rules:

- **Weight:** exactly two. *Hairline* = `StyleSheet.hairlineWidth` (1px physical) in
  `border`; *emphasis* = 2pt in `text` colour (full ink). Nothing in between.
- **Hairlines go:** under the screen header (full-bleed); between list rows (full-bleed);
  above and below machine panels (full-bleed); above the input dock/key bar; between
  ledger sections.
- **Emphasis rules go:** under the active element in a text-tab/segmented control (in
  `accentGraphic`, 2pt — this *is* the selection state); as the top rule of a screen's
  single most important data block (optional, at most one per screen, in `text`).
- **Rules must not:** form a closed box (that is a card); appear on all four sides of
  anything; sit within 8pt of another parallel rule; separate a label from its own
  content (labels bind to content by proximity, rules separate sections).
- **Vertical rules:** only inside ledger rows to separate paired cells, hairline weight,
  full row height. Nowhere else.

---

## 7. What replaces the card

The replacement is the **section**: `label` marker → content → full-bleed hairline. Plus
two recurring patterns:

- **Ledger row** — `label` key at the left margin, mono value flush right, 44pt min
  height, hairline below. The reference's `LOCATION: ENGLAND … 14:54` footer,
  generalised. Used for all key-value data.
- **Meter section** — for live stats: `label` + big `numeral` on one baseline-aligned
  row, a 2pt full-width track underneath (track in `surfaceAlt`, fill in status colour),
  then a `caption`/`mono` detail line. The sparkline survives as a 32pt-tall inline
  strip on the right of the numeral row, drawn in `textFaint` with the status colour on
  the last segment.

### 7.1 Before/after — System

**Before** (screenshot 06): five white rounded cards floating on blue-grey, each with its
own border, radius and shadow; a pill badge for the OS; bold coloured percentages; a
segmented control in a sixth card.

**After:** one continuous ledger.

```
MOSSS-MACBOOK-AIR.LOCAL            (title, 28 UPPER, one line)
● LIVE · UPDATED 2S AGO            (label; dot = accentGraphic, pulsing)
────────────────────────────────── (hairline, full bleed)

CPU                       39%      (label left · numeral right, good-coloured
▁▂▂▃▅▃▃▂                           sparkline inline; 2pt track below, fill good)
━━━━━━━━──────────────────
APPLE M3 · 8 CORES        AVG 39 · PEAK 41   (micro, textFaint)
────────────────────────────────── (hairline)
MEMORY                    97%      (numeral in bad; track fill bad)
…
────────────────────────────────── 
UPTIME:      33D 21H               (ledger rows)
OS:          MACOS 26.3.1
INSTALLED:   16.0 GB
──────────────────────────────────
UPDATE RATE   1S  [2S] 5S  PAUSED  (text segmented: selected gets accent +
                                    2pt accentGraphic underline, no pill)
```

No fills, no radii. The status colour lives in the numeral and the track fill only. The
OS badge dies; the OS is a ledger row. Everything sits on one grid so scanning down the
left edge reads the labels and down the right edge reads the numbers.

### 7.2 Before/after — Files

**Before** (screenshot 05): pill-buttons for Home/Desktop/Documents, a rounded filter
field, a pill segmented sort bar, then rows with rounded blue folder icons, bold names,
date beneath, chevron right — every control a different rounded shape.

**After:**

```
FILES · 92 ITEMS                   (title + mono count on one line)
● CONNECTED                        (label status line)
──────────────────────────────────
HOME   DESKTOP   DOCUMENTS   DOWNLOADS      (label text-tabs; active = accent
━━━━                                         + 2pt underline; scrolls horizontally)
/USERS/MOSSLOUVAN                  (mono path, tappable = go-to sheet; ↑ parent
                                    action flush right on the same row)
[ Filter this folder…            ] (surface-filled input, 1 hairline border,
──────────────────────────────────  2pt radius — the only filled control)
NAME ▾         SIZE        DATE    (label column headers; active sort = accent;
────────────────────────────────── tapping toggles direction — this row IS the
▸ .AGENTS                  JUL 27   sort control, no segmented bar)
──────────────────────────────────
▸ .AGENTSKILLS             MAR 30
──────────────────────────────────
  README.MD      4.2 KB    AUG 13  (files: name mono, size+date right-aligned
──────────────────────────────────  mono in textDim; directories get ▸, no
                                    icon art, no chevron)
```

Rows are 52pt, name in `mono` 13 (paths are machine voice), hairline between rows. The
folder icon is replaced by a `▸` glyph in `textDim`; the trailing chevron dies — the row
itself is obviously tappable because every row in this app is (§11.1). Sort moves into
the column header where desktop file browsers have taught everyone it lives.

### 7.3 Before/after — Agent session list

**Before**: each session a rounded card with badge, title, caption, buttons inside;
skeleton cards while loading; a "new project" card with an input.

**After:**

```
AGENT                              (title)
● HOST CONNECTED                   (label)
──────────────────────────────────
SESSIONS                    + NEW  (label section marker; "+ NEW" is a label
────────────────────────────────── button in accent, right-aligned)
● RUNNING          BELAY          (row: status label in status colour, project
  Fix the stream reconnect bug     mono right; second line = task in body,
  12 MIN AGO · 3 APPROVALS WAITING  third = micro in textFaint; approvals
──────────────────────────────────  waiting shown in warn, counts are real)
○ IDLE             ROOMSCAN
  Bench loop refactor
  2 H AGO
──────────────────────────────────
○ DONE             STUCK-LOG
  Daily entry scaffold
  YESTERDAY
──────────────────────────────────
```

Three-line rows, uniform anatomy, hairline-separated. The status dot column keeps all
statuses vertically aligned so the list scans as a table. Long-press a row for Remove
(destructive), and the same Remove also exists inside the opened session (§11.2 —
gesture-only routes are forbidden). Loading = the same rows with skeleton bars in
`skeleton` colour at the exact text positions — the layout never reflows when data lands.

---

## 8. Screens: where the eye lands first

Per §2.2 each screen has one display-weight element; the type scale enforces the landing
point because nothing else on the page exceeds `label` weight except the title and the
hero element.

| Screen | Eye lands on | Enforced by |
|---|---|---|
| Connect | "BELAY" brand block, then the address input | `display` 40/900; the input is the only `surface` fill on the page |
| Devices | The last-used computer's name | Its row alone uses `subheading` 700; others body |
| Screen | The live video (or its empty state, §9) | It is the only machine panel; chrome around it is `label`-sized |
| Terminal | Last line of output / the command input | Input dock is anchored bottom with the only accent button ("RUN") |
| Files | The path row, then the first rows | Path is the only mono line above the rules |
| System | The first numeral (CPU %) | `numeral` 34/800 is the largest ink on the page |
| Agent | The RUNNING session / approval prompt | Only running rows get the pulsing accent dot; approvals get the page's one warn-soft band |

---

## 9. The Screen tab (hardest screen)

The problem: an editorial page has to survive around a black rectangle of arbitrary
aspect ratio, with a mode toggle (Touch/Pad), zoom, keyboard, key bar, and a live
error/reconnect story. Today it is a floating black rounded box stranded in whitespace
with a lonely "No picture from the host." — the worst screen in the app.

**Layout:** standard header block (hostname `title`, `● LIVE / ● RECONNECTING` label
line, hairline). Then the machine panel, **full-bleed**, top-aligned directly under the
header rule — never vertically centred. The panel's height is the video's natural height
at fit-width; while there is no video it takes a fixed 9:16-of-width height (≈220pt) so
the page never jumps. Below the panel: a hairline, then the control dock pinned above
the tab bar:

```
TOUCH   PAD        2×   ⌨ KEYBOARD   Aa
━━━━━
──────────────────────────────────────
```

— a `label` text-segmented control (active = accent + underline) plus labelled controls.
Every control in the dock gets a mono label; no bare icons (§11.1). Zoom moves out of
the video overlay into the dock; the fullscreen control stays on the panel (top-right,
`onMachineDim`, with label "FULL") because it acts on the panel itself.

**The empty state, solved** (§11.4 anatomy applied): while disconnected/erroring, the
machine panel does not sit dumb. Its full area becomes the guidance surface — content
centred *inside the panel* (the one sanctioned centring), set in the machine voice:

```
┌────────────────────────────────────────┐ (machine panel, full-bleed)
│                                        │
│   NO SIGNAL                            │  label, onMachineDim
│                                        │
│   No active display on the Mac.        │  body, onMachine — says what is
│   It may be asleep or headless.        │  true, not whose fault it is
│                                        │
│   [ WAKE AND RETRY ]                   │  the screen's one accent button
│   RETRYING IN 4S…                      │  micro, onMachineDim, live countdown
│                                        │
└────────────────────────────────────────┘
```

The red banner above the video dies: the panel *is* the error state. One place to look,
the accent marks the way forward, and the countdown proves the app is alive. Different
causes get different first lines ("HOST UNREACHABLE", "STREAM ENDED", "NO SIGNAL") but
identical anatomy.

---

## 10. Terminal and motion

**Terminal:** header block, then the machine panel fills all space between header rule
and input dock. Output in `mono` (S/M/L still switches 11/13/15). The pty badge becomes
a `PTY` micro-label in the header status line. The key bar (`ctrl alt esc tab …`) sits on
`surfaceAlt` square keys, 2pt radius, mono labels, 44pt tall, single hairline above. The
input dock: mono input on `surface`, the accent "RUN" label-button at right. The
prompt-continuation `>` indicator stays. This screen changes least — it is already the
closest to the target aesthetic; the work is deleting the card around the output.

**Motion:** small, fast, honest.

- Durations: `fast 120ms` (state flips: selection underline slide, dot pulse step),
  `base 180ms` (row press, sheet content fade), `slow 240ms` (sheet slide-up). Nothing
  longer. Easing: standard ease-out; springs are retired (`motion.spring` deleted).
- Distances: translations max 8pt (list item entrance: 8pt up + fade). Sheets slide from
  the bottom edge only.
- Press feedback: opacity 1 → 0.55 on the pressed element. **No scale transforms** —
  editorial surfaces do not squish. `motion.pressScale` is deleted.
- The live dot pulses opacity 1 → 0.4, 1.2s loop. The streaming cursor blinks 600ms.
- `useReducedMotion()`: all translations become pure opacity fades; pulse/blink stop at
  full opacity; durations halve.

---

## 11. Discoverability doctrine

Minimal editorial design earns its calm by removing affordances; Belay is a dense
utility. These rules resolve the conflict, and **rule 8 of §2 governs: findable wins.**

### 11.1 How a control announces itself — the rule

> An icon may stand alone **only if** it is one of the platform-universal five — back
> (‹), close (×), add (+), search (⌕), overflow (⋯) — **and** it sits in a screen
> corner or row-trailing position where those five conventionally live. Every other
> interactive element carries its wide-tracked mono label, and any bare glyph still
> gets an `accessibilityLabel`.

Consequences applied: the refresh icon becomes `↻ REFRESH`? No — refresh is replaced by
the live "UPDATED 2S AGO" status plus pull-to-refresh, and a labelled `RETRY` appears
only when polling has failed. The keyboard toggle becomes `⌨ KEYBOARD`. The zoom stepper
becomes `2×` with `−`/`+` (mathematical symbols count as labels). Tab bar items keep
their mono labels — icons in the tab bar may be dropped entirely in favour of pure
labels (the reference's nav is text-only); if icons stay they are 1.5pt-stroke outlines
in the label's colour, never filled blobs.

Additionally: **anything tappable must look different from anything not tappable.**
In a borderless system that means: interactive text is `label` style (chrome) or carries
the accent (selected/primary); whole-row tap targets are hairline-bounded rows in lists
where *every* row is tappable — mixed lists of tappable and static rows are forbidden.

Because a section marker, a ledger key and a quiet button are otherwise the *same*
11pt tracked uppercase mono, that difference is carried by one reserved mark:

> **The track rule.** Interactive text is marked; inert text never is. Any tappable
> text element that is not a filled or hairline-outlined button carries exactly one
> reserved mark: the 2pt underline track — `accentGraphic` when selected or active,
> `accentDim` at rest. No section marker, ledger key, status word, count, or any other
> inert label may ever carry the track, and no tappable label may ever appear without
> it. A label without a track does nothing; a label with one is a control. A disabled
> tracked label dims as a whole — label and track together — so it stays a dimmed
> control rather than decaying into the inert class. (Trailing `‹ › × + ⌕ ⋯` in their
> conventional corner/trailing positions remain the only other sanctioned text
> affordance.)

The mark is the segmented control's own selection language, so it adds no vocabulary —
it makes the selected state *stronger*: the lit track reads as "the one switched on
among the marked", not "the only thing marked at all". The primitive is
`app/src/ui/track-label.tsx` (state logic in `track.ts`); the segmented control, the
Screen dock, the Files roots and sort header, the path bar's COPY and the `ghost`
button variant all speak it. Do not draw the mark by hand.

### 11.2 Hierarchy of discovery, per screen

- **Visible without interaction:** everything needed for the screen's core loop.
  Screen: mode, zoom, keyboard, connection state. Terminal: key bar, input, run,
  size. Files: path, sort, filter, parent. System: all stats, rate. Agent: sessions,
  their states, pending approval count, new-session.
- **One tap deep (sheet or header action):** secondary settings and rarer verbs —
  theme toggle, forget-this-computer, go-to-path, file info, agent session
  options. A sheet is announced by a labelled control (`⋯` counts, per 11.1).
- **Long-press / gesture:** shortcuts only, never the sole route. Long-press a session
  row → Remove (also in the session's ⋯ sheet). Pull-to-refresh (also implied by the
  auto-poll). Pinch-zoom on the video (also the dock stepper). Every gesture has a
  visible twin.
- **Never hidden:** destructive actions are one tap deep at most, always behind a
  confirm, always labelled with the noun ("FORGET THIS COMPUTER", not "Forget").
- **The keyboard is a state, and every state needs a visible exit.** Any surface that
  can raise the software keyboard must offer (a) drag-to-dismiss on its scrollable —
  `keyboardDismissMode="interactive"` — and (b) a visible dismiss control while the
  keyboard is up: the TYPE row's trailing `×`, the terminal key bar's `⌄ HIDE` key, a
  sheet's own `×`. Tap-outside and toggle-off may exist as shortcuts, never as the
  sole route — least of all where "outside" does something (the stage clicks the PC,
  a Files row navigates). And `keyboardShouldPersistTaps` stays `"handled"`: the
  default swallows the first tap on every control while the keyboard is up, trading a
  findability bug for a worse one.

### 11.3 Naming and labels

- Plain words over jargon: "computer", not "host", in anything the user reads
  ("HOST" may survive only in developer-facing terminal/agent output). "Can't reach
  your computer", not "connection refused".
- Two cases only: `label`/`micro` chrome is UPPERCASE MONO; prose is sentence case
  sans. Title Case is banned.
- One verb per action everywhere: **Connect / Disconnect · Retry · Forget · Remove
  (list items) · Approve / Deny · Run · Open**. Never "Retry now" here and "Try again"
  there.
- Buttons name the outcome, not the mechanism: "SCAN CODE", "WAKE AND RETRY",
  "NEW SESSION".

### 11.4 Empty and error states: anatomy

The app's real historical failures — a pairing screen demanding a code the host stopped
issuing; a network block reported as "Tailscale is off" (blaming the wrong thing); the
stranded black rectangle — were all states that described instead of guided. Every
empty/error state is built from this fixed anatomy, in this order:

1. **STATE NAME** — `label`, dim (or status colour if error): "NO SIGNAL",
   "NOTHING HERE YET", "CAN'T REACH YOUR COMPUTER".
2. **What is true** — one or two `body` sentences stating the *observed fact*, never a
   guessed cause presented as fact. If the cause is a guess, say so: "This usually
   means the Mac is asleep." A wrong confident diagnosis (the Tailscale incident) is
   worse than an honest "couldn't connect".
3. **The way forward** — the screen's single accent element: one primary action that
   can actually succeed from here ("WAKE AND RETRY", "SCAN CODE AGAIN", "START THE
   HOST AGENT" with the command shown in mono). If the fix happens on the computer,
   show the exact command to run there. Never render a dead-end: if a code can expire,
   the expired state must offer the re-issue path, not keep demanding the code.
4. **Proof of life** — a `micro` line showing the app is still working: "RETRYING IN
   4S…", "LAST TRIED 12:04:31". Static error screens read as crashes.

Empty states (no data, no error) use the same anatomy minus the status colour, and are
allowed one `display`-weight word as the landing point on otherwise-empty screens.

### 11.5 Where restraint loses (explicit trade-offs)

- The reference's nav is unlabelled-minimal and hover-dependent → our tab bar and dock
  are fully labelled. The aesthetic cost (more text in chrome) is paid.
- The reference centres almost nothing and would strand an empty state in whitespace →
  we centre guidance *inside machine panels* and fill them.
- Pure whitespace separation would make Files/Agent lists ambiguous to tap → hairline
  row separation everywhere, though the reference has almost no rules.
- A single accent per screen is the rule, but an approval prompt on the Agent tab may
  carry an accent "APPROVE" even while a running session pulses — safety-relevant
  actions outrank the one-accent rule.

---

## 12. Never do this

- No cards: no closed border boxes, no fills behind grouped content, no corner radius
  above 4pt anywhere (2pt standard; 4pt only on key-bar keys), no shadows/elevation.
- No gradients. Anywhere. Including "subtle" ones behind video chrome.
- No pill shapes: no pill badges, pill buttons, pill segmented controls.
- No second accent, no per-screen colour themes, no blue (the old identity is retired;
  the reference's blue dot does not survive the translation — one accent).
- No centred text outside machine panels and the connect brand block.
- No Title Case; no bold mono; no `label` above 11pt; no tracking on lowercase text.
- No icon-only controls beyond the universal five (§11.1); no filled icon blobs.
- No gesture-only routes to any function; no destructive action without a confirm.
- No confident diagnosis of an unverified cause in an error message.
- No spacing value outside the scale; no hand-tuned "17pt because it looked right".
- No scale-transform press effects; no animation over 240ms; no unfaded pulse under
  reduced motion.
- No mixed tappable/static rows in one list; no chevrons as decoration.
- No text under 4.5:1 composited, no UI mark under 3:1 — re-run the contrast script
  when any colour or alpha changes.

---

## Sources

Swiss/ITS grounding: [International Typographic Style — Wikipedia](https://en.wikipedia.org/wiki/International_Typographic_Style) (grid, asymmetry, flush-left sans, objectivity), [Josef Müller-Brockmann — Wikipedia](https://en.wikipedia.org/wiki/Josef_M%C3%BCller-Brockmann) (grid systems as programme), [Swiss Style: Principles, Typefaces & Designers — PRINT](https://www.printmag.com/featured/swiss-style-principles-typefaces-designers/), [Guide to Swiss Design — Big Human](https://www.bighuman.com/blog/guide-to-swiss-design-style). Brutalist/editorial web adaptation: [Brutalist Web Design — Superdesign](https://superdesign.dev/styles/brutalism) (flat ground, hard rules, heavy grotesque + mono pairing, Archivo Black/Space Mono), [Brutalist & Editorial Web Design — Social Animal](https://socialanimal.dev/solutions/brutalist-editorial-web-design/) (print-magazine hierarchy on raw web surfaces), [Web Design Trends 2026 — Fireart](https://fireart.studio/blog/the-best-web-design-trends/) (type as primary interface architecture). Standards: WCAG 2.1 §1.4.3 (4.5:1 text) and §1.4.11 (3:1 non-text), Apple HIG (44pt targets, Dynamic Type), Butterick's *Practical Typography* (letterspacing 5–12% for caps, line-height ratios).
