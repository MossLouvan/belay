# Findability Audit — the Ledger migration

*Audited 2026-08-31 against commits `e61cc5d` (foundation) and `68fc18c` (screen migration),
by reading every migrated screen's code plus `docs/DESIGN.md` §11, `docs/PRODUCT-REVIEW.md`,
and the pre-redesign screenshots. I could not run the app on a phone; every finding below is
grounded in a specific file and line, and where a suspected regression turned out fine I say
so in §4 rather than inventing a finding.*

**The owner's verdict this answers:** the look is a big improvement and stays; some things
became harder to find. This document lists exactly which things, why in interaction terms,
and the fix inside the Ledger system — never a revert to cards.

---

## 1. Ranked findings

| # | Finding | Where | Priority | Effort |
|---|---|---|---|---|
| 1 | **The keyboard has no visible way out** — no dismiss affordance, no drag-to-dismiss anywhere; on the Screen tab it traps you until you rediscover the TYPE toggle | `app/app/(tabs)/screen.tsx:270-283`, every scrollable (zero `keyboardDismissMode` in the app) | **P1** | S–M |
| 2 | File details / copy-path reachable **only** by long-press; the only signpost is a 10pt footer at the bottom of the list | `app/src/files-row.tsx:50`, `app/app/(tabs)/files.tsx:381` | **P1** | M |
| 3 | Agent session list: reload is gesture-only, staleness is invisible — no poll, no "updated Ns ago", no hint anywhere | `app/src/agent/session-list.tsx:109-111,166` | **P1** | S |
| 4 | Screen dock keys have zero resting affordance; the momentary keys (`−`, `1.0×`, `+`, `MON n/m`) never signal at all | `app/src/screen/dock.tsx:57` | **P1** | S |
| 5 | Files root tabs: unselected roots are bare dim labels — indistinguishable from the inert item-count label two lines up | `app/app/(tabs)/files.tsx:255,283-297` | **P1** | S |
| 6 | Sort header columns look inert; only the active one carries any mark | `app/src/files/sort-header.tsx:66-69` | P2 | S |
| 7 | The pull-to-refresh hint lives at the **footer** of a scrolling list and disappears when the list is empty | `app/app/(tabs)/files.tsx:379-383` | P2 | S |
| 8 | Path bar "COPY" is a dim label identical to every inert label on the screen | `app/src/files/path-bar.tsx:146` | P2 | S |
| 9 | "CANCEL" (tappable, dim) sits directly above "PICK WHERE CLAUDE WORKS" (inert, dim) in the identical style; disabled "+ NEW SESSION" also decays to the inert style | `app/src/agent/session-list.tsx:63,391-393` | P2 | S |
| 10 | `ghost` buttons are bare labels — "REFRESH", "DONE", "TYPE IT INSTEAD" have no box, no underline, no accent | `app/src/ui/button.tsx:46`, `app/app/devices.tsx:166`, `app/src/files/info-card.tsx:44` | P2 | S |
| 11 | Files spends the accent three ways at once (active root, active sort, "GO TO…"), so accent stops reliably meaning "this is the live selection" | `app/app/(tabs)/files.tsx:251` + sort header + root tabs | P3 | S |

## 2. The one rule that would prevent all of this

Almost every finding is the same failure: **the system lets inert `label`/`micro` text and
tappable `label`/`micro` text render identically** (11pt tracked uppercase mono, `textDim`).
The keyboard trap (finding 3.1) is the same disease applied to a *toggle*: the state that
would tell you the way out is carried by the same undifferentiated label style. Proposed
addition to DESIGN.md §11.1, using a mark the system already owns (the SegmentedControl's
2pt track, `app/src/ui/controls.tsx:104-113`):

> **The track rule.** Interactive text is marked; inert text never is. Any tappable text
> element that is not a filled or hairline-outlined button carries exactly one reserved
> mark: the 2pt underline track — `accentGraphic` when selected or active, `accentDim`
> (or `surfaceAlt`) at rest. No section marker, ledger key, status word, count, or any
> other inert label may ever carry the track, and no tappable label may ever appear
> without it. A label without a track does nothing; a label with one is a control.
> (Trailing `‹ › × + ⌕ ⋯` in their conventional corner/trailing positions remain the
> only other sanctioned text affordance.)

This is quiet — a 2pt dim line under a word — but it is unmistakable, it is already the
system's selection language so it adds no new vocabulary, and it makes the selected state
*stronger* (the accent track reads as "the lit one among the marked ones" instead of "the
only one marked at all").

A second, narrower doctrine line falls out of finding 3.1 and belongs in §11.2:

> **The keyboard is a state, and every state needs a visible exit.** Any surface that can
> raise the software keyboard must offer (a) drag-to-dismiss on its scrollable, and (b) a
> visible dismiss control while the keyboard is up. Tap-outside and toggle-off may exist
> as shortcuts, never as the sole route.

---

## 3. Findings in full

### 3.1 — P1 · The keyboard has no visible way out (worst on the Screen tab)

**What the owner hit:** the keyboard came up, covered the UI, and there was no visible way
to drop it; he "shimmied" around, scrolled hunting for empty space to tap, and eventually
discovered that pressing the TYPE dock key a second time closes it. That toggle is the
*only* deliberate route on the Screen tab, and nothing teaches it.

**The facts, per surface** (verified: there is not a single `keyboardDismissMode` prop or
`Keyboard.dismiss()` call anywhere in `app/`):

- **Screen tab, TYPE row** (`app/app/(tabs)/screen.tsx:270-283`): the input `autoFocus`es
  when TYPE opens. The row is *not* inside a ScrollView, so there is no scroll gesture and
  no reliable tap-outside: taps on the stage are **remote mouse clicks** (tapping "empty
  space" here clicks the PC), and every dock key handles its own tap. Routes that exist:
  the keyboard's own "send" key (single-line default `blurOnSubmit` — but that *sends the
  text*, so it's unusable for "never mind"), and re-tapping TYPE. The on-screen SEND button
  does not blur. This is the trap: dismissal requires either sending unwanted text or
  knowing an unmarked toggle. **This is the one surface where the app genuinely locks you
  in.**
- **Terminal** (`app/app/(tabs)/terminal.tsx:355-380`): `blurOnSubmit={false}` — correct
  for running successive commands, but it means the return key *never* dismisses. The key
  bar (`keyboardShouldPersistTaps="always"`, `terminal-keys.tsx:121,151`) rightly keeps the
  keyboard up. The only dismiss is tapping the transcript (the output list's
  `keyboardShouldPersistTaps="handled"`, `terminal-output.tsx:130`, lets a tap on
  non-interactive content blur) — invisible, and the transcript is a black panel that gives
  no hint it does this.
- **Agent composer** (`app/src/agent/session-view.tsx:205-230`): `multiline`, so return
  inserts a newline and there is no Done key at all; SEND does not blur. Only route:
  tapping the feed (`keyboardShouldPersistTaps="handled"`, line 122) — invisible, and a tap
  that lands on a selectable mono event row may start a text selection instead.
- **Files filter** (`app/app/(tabs)/files.tsx:314-322,360`): the list has
  `keyboardShouldPersistTaps="handled"`, but nearly every point in it is a tappable row —
  so the "tap outside" dismiss usually *navigates into a folder* as a side effect. No
  `keyboardDismissMode`, so dragging the list scrolls under a keyboard that stays up.
- **Sheets — Go to folder, New project** (`go-to-sheet.tsx:77`,
  `new-project-sheet.tsx:87,117`): inputs `autoFocus`, but the Sheet has a visible `×` and
  a backdrop press (`app/src/ui/sheet.tsx:65-110`), and closing the sheet takes the
  keyboard with it; `returnKeyType="go"/"done"` submits also dismiss. **These are fine.**
- **Connect address / pairing code** (`host-step.tsx:125`, `code-input.tsx:166`):
  single-line, `returnKeyType="go"` submit-dismisses, and the page ScrollView's
  `keyboardShouldPersistTaps="handled"` (`app/app/index.tsx:430`) gives tap-outside on a
  page with real empty space. **Adequate**, though drag-to-dismiss (below) should land here
  too for free.

**Why it's a regression class of its own:** every dismiss route in the app today is either
invisible (tap the transcript, tap a gap that dense ledger lists barely have), destructive
(tap dismisses *and* opens a folder / clicks the PC / sends text), or unmarked (the TYPE
toggle). §11.2's rule — every gesture has a visible twin — applies to exits, not just
entries.

**Fix — redundant routes, in three layers:**

1. **Drag-to-dismiss everywhere, one line per scrollable.** Add
   `keyboardDismissMode="interactive"` (falls back to `"on-drag"` behaviour on Android) to:
   the shared `Screen` scroll container (`app/src/ui/layout.tsx:66` — covers Connect,
   Devices and future screens at a stroke), the Files FlatList (`files.tsx:352`), the
   Terminal output list (`terminal-output.tsx`), the Agent feed and both Agent list scrolls
   (`session-view.tsx:118`, `session-list.tsx:158,384`). This is the gesture iOS users
   already own; it costs nothing visually. It cannot help the Screen tab (no scrollable) —
   hence layer 3.
2. **Keep tap-outside working, but keep it `"handled"`.** The current
   `keyboardShouldPersistTaps="handled"` settings are correct and must not be "simplified"
   to the default: the default swallows the first tap on every button while the keyboard is
   up, which would convert this findability bug into a much worse one (SEND, RUN, Allow /
   Deny each needing two taps). No change — just a warning against one.
3. **A visible dismiss control wherever the keyboard can be up.** `returnKeyType="done"` is
   *not* sufficient here — the Screen and Terminal inputs use return to send, and the Agent
   composer is multiline where return types a newline. In-system affordances:
   - **Screen tab:** give the TYPE row a trailing `×` (universal five, row-trailing —
     `Input` already takes a `trailing` slot) that blurs and closes `typeOpen`; it is the
     visible twin of the TYPE toggle. And per the track rule, TYPE's *active* state must be
     unmistakable: today it is an accent label + 2pt underline, which is the right language
     — but it only reads as "on" once resting tracks exist under the other keys (finding
     3.4); with every key tracked `accentDim` and TYPE alone lit `accentGraphic`, "press it
     again to close" becomes legible. The dock does remain visible above the keyboard
     (`KeyboardAvoidingView` padding), so the signal is at least on screen.
   - **Terminal:** add a `⌄ hide` key at the trailing end of the key bar — the key bar is
     exactly the surface terminal apps put keyboard controls on, it already sits directly
     above the keyboard, and a mono-labelled key is native Ledger vocabulary.
   - **Agent composer:** the layer-1 interactive drag on the feed is the primary route
     (the natural gesture is "scroll up to re-read, keyboard follows"); additionally blur
     the input on SEND — after sending from a phone you want the reply, not the keyboard.
     If a fourth route is wanted, an accessory `DONE` (iOS `InputAccessoryView`) fits, but
     it is iOS-only chrome; the drag + blur-on-send pair covers the loop.
   - **Files filter:** layer 1 (drag the list) plus blur-on-submit (single-line default)
     already suffice once drag works; no extra chrome.

**Priority P1** — it blocks ordinary navigation, the owner hit it on day one, and the
Screen tab variant has no non-destructive escape at all. **Effort:** S for layers 1–2 and
the Screen `×`; M in total with the terminal key and composer blur.

### 3.2 — P1 · Long-press is the only route to a file's details and path

**What:** On Files, an entry's kind/size/full-path panel and its "Copy path" action open
only by long-pressing a row (`app/src/files-row.tsx:50-53` → `InfoCard`,
`app/app/(tabs)/files.tsx:389`). There is no visible control anywhere that reaches the same
information.

**Why it's a regression:** DESIGN.md §11.2 is explicit — "Long-press / gesture: shortcuts
only, never the sole route… Every gesture has a visible twin." This gesture has no twin.
The only teaching is `accessibilityHint` (invisible to sighted users) and the list-footer
Micro line (finding 3.7), which a user must scroll past every row of a 92-item folder to
meet, and which does not render at all in an empty or fully-filtered folder. Someone who
does not already know the gesture cannot discover "copy this file's path" — a core task for
a tool whose Agent and Terminal tabs both eat paths.

**Fix (in-system):** give every row a trailing `⋯` — the overflow glyph is one of §11.1's
universal five, and row-trailing is exactly its sanctioned position. Render it in
`textFaint` at the row's right edge (after the size/date cell), 44pt hit target via
`hitSlop`, opening the same `InfoCard`. Keep long-press as the shortcut it was meant to be.
If per-row chrome feels too loud, the minimum acceptable alternative is a `⋯` on the
*selected* row only plus moving the hint line to the header (3.7) — but per-row is what
§11.2 actually asks for. **Priority P1 · Effort M** (a trailing slot in `FileRow`, no data
changes).

### 3.3 — P1 · Agent session list: reload is gesture-only and staleness is invisible

**What:** The session list fetches once on mount (`app/src/agent/session-list.tsx:109-111`)
and again only on pull-to-refresh. There is no interval, no socket, no "UPDATED 2S AGO"
line — the status line says only "HOST CONNECTED" (line 166) — and no hint that
pull-to-refresh exists (Files at least has its footer line; Agent has nothing). The only
visible reload affordance is "Try again" inside the error banner, which appears only when a
request has already failed.

**Why:** §11.1's stated replacement for the refresh icon was "the live 'UPDATED 2S AGO'
status plus pull-to-refresh". Agent got the icon removal without the replacement. §11.2
allows pull-to-refresh as a shortcut because it is "also implied by the auto-poll" — but
this screen has no auto-poll, so the gesture is the sole route. Consequence (confirmed
independently by PRODUCT-REVIEW §2.4): status dots on the list go stale within seconds —
a session flips to "waiting for approval" and the list keeps saying "working", and nothing
on screen suggests the data is old or how to renew it.

**Fix:** poll `refresh()` on a ~5s interval while the tab is focused (the pattern System
already uses), and put the freshness in the header status line where every other tab puts
it: `● HOST CONNECTED · UPDATED 3S AGO`. That line is the visible twin; pull-to-refresh
becomes the shortcut it is everywhere else. **P1 · Effort S.**

### 3.4 — P1 · Screen dock keys carry no resting affordance

**What:** Every dock control (`TOUCH`, `PAD`, `−`, `1.0×`, `+`, `R-CLICK`, `2×CLICK`,
`KEYS`, `TYPE`, `MON n/m`) is a `textDim` mono label whose underline is `'transparent'`
until active (`app/src/screen/dock.tsx:57`). The shared `SegmentedControl` draws an
`accentDim` resting track under *unselected* options precisely so "the strip reads as one
control, not scattered words" (`app/src/ui/controls.tsx:104-113`) — but the dock
deliberately bypasses that component (comment at `dock.tsx:11-15`) and dropped the track
with it.

**Why:** Two lines of dim tracked mono over the page background are visually identical to
the inert status line ("● LIVE · 24 FPS") above the panel. Worse, the momentary keys — both
zoom steppers, the zoom-level reset, and `MON n/m` — have no active state ever, so they
never once display any signal that they are controls. A user who doesn't know the dock is a
dock sees a caption row. (Legibility itself is fine: 11pt tracked Menlo with 44pt targets;
and *when* a key is active, accent + 2pt underline is an unmistakable selected state. The
gap is purely the resting affordance.) This finding also feeds the keyboard trap (3.1):
with no resting tracks, TYPE-lit-orange does not read as "one switched-on key among keys" —
it reads as one more coloured word.

**Fix:** apply the track rule (§2): every DockKey keeps a 2pt track — `accentDim` at rest
(the fullscreen/HUD variant can use `HUD.hairline`), `accentGraphic` when active. Give
TOUCH/PAD one continuous track so they read as a two-position switch, matching the
segmented control exactly. One style line in `DockKey`. **P1 · Effort S.**

Related, smaller: tapping `1.0×` resets/fits the zoom, announced only via
`accessibilityLabel` (`dock.tsx:201-207`). With the track it at least reads as tappable;
consider labelling it `FIT` whenever zoom ≠ 1.0 so the outcome is named (§11.3). **P3 · S.**

### 3.5 — P1 · Files root tabs don't read as tappable

**What:** The root selector (`HOME DESKTOP DOCUMENTS DOWNLOADS`,
`app/app/(tabs)/files.tsx:267-297`) renders unselected roots as `tone="dim"` labels with a
`'transparent'` underline (lines 290-296). Two lines above sits the inert count line
"92 ITEMS · 3 FOLDERS" (line 255) — the same 11pt dim tracked mono. Directly below sits the
sort header — also the same style.

**Why:** The screen's top third is four stacked lines of visually identical micro-labels of
which two are tap targets and two are not. The selected root does announce itself (accent +
2pt underline), but the *other* roots — the ones a user must find to switch — carry nothing.
The old pills were ugly but every root looked pressable; that affordance was removed and
nothing replaced it. This is also internally inconsistent: the app's own SegmentedControl
gives unselected options a resting track for exactly this reason.

**Fix:** the track rule — `accentDim` resting track under unselected roots, `accentGraphic`
under the active one (change line 295's `'transparent'` to `theme.colors.accentDim`).
**P1 · Effort S** (one line).

### 3.6 — P2 · Sort header columns look inert

**What:** `NAME KIND SIZE DATE` (`app/src/files/sort-header.tsx:66-69`): inactive columns
are plain dim labels; only the active column gets accent + `▲/▼`.

**Why:** The header keeps Finder's *behaviour* (tap to sort, tap again to flip — good) but
sheds Finder's affordance: on the Mac the header is a visibly bordered, hoverable bar; here
the three inactive columns are indistinguishable from the count label and from any section
marker. Nothing says "these words change the order of everything below them." A user will
still find Name-sorting (it's active by default and marked), but Size/Date/Kind sorting has
become invisible functionality.

**Fix:** the track rule — resting `accentDim` track under all four columns (they become a
recognisable sibling of the segmented control), keeping accent + caret for the active one.
Alternative if the row then feels too heavy next to the filter field: a `⇅` glyph slot in
`textFaint` on each inactive column. Prefer the track for consistency. **P2 · S.**

### 3.7 — P2 · The reload/details hint is a footer at the end of the list

**What:** "PULL DOWN TO RELOAD · LONG-PRESS A ROW FOR DETAILS"
(`app/app/(tabs)/files.tsx:379-383`) renders as a `Micro` (10pt, `textFaint` — the app's
least legible style) **after the last row** of the list, and only when `visible.length > 0`.

**Why:** A signpost must be seen before the need arises. In `~` with 92 items the hint is
several screens below the fold; in the empty/filtered state — where a user most wants a
reload — it is removed. Instructional text at a list footer teaches only users who read to
the end of their home directory, i.e. nobody. It is honest but positioned to fail.

**Fix:** move the freshness signal into the fixed header where the spec puts it on every
other tab: the status line under the title becomes `● CONNECTED · AS OF 14:02` (data
already in `now`), which both proves freshness and implies renewability; with 3.2's per-row
`⋯` the long-press half of the hint becomes redundant and the footer can go entirely.
**P2 · S.**

### 3.8 — P2 · "COPY" in the path bar is invisible as a control

**What:** The copy-path control (`app/src/files/path-bar.tsx:146`) is a `tone="dim"` label
— identical in every respect to the inert section markers and the count line.

**Why:** It sits at the end of a row of mono breadcrumbs, as a dim mono word. Nothing
distinguishes "COPY" (a verb you can tap) from "KIND" (a sort column), "SELECTED" (a
marker), or "92 ITEMS" (a count). Its state feedback (`✓ COPIED` / `✗ FAILED`) is good —
but only reachable by someone who already guessed it was tappable.

**Fix:** the track rule (resting `accentDim` track under COPY), which also gives its
✓/✗ states a natural home (track turns `good`/`bad` during the flash). **P2 · S.**

### 3.9 — P2 · Tappable and inert labels collide head-on in the Agent picker

**What:** In `ProjectPicker` (`app/src/agent/session-list.tsx:388-393`) the header row ends
with "CANCEL" — a `LabelButton` with `tone="dim"` — and the very next line is the inert
marker "PICK WHERE CLAUDE WORKS", in the identical style, 4pt below. Additionally,
`LabelButton`'s disabled state (line 63) swaps `accent` → `dim`, so a disabled
"+ NEW SESSION" becomes a twin of the "SESSIONS" marker sitting on the same line.

**Why:** This is the purest instance of the systemic failure: two adjacent lines of
identical text where one is a control and one is a caption. The enabled accent-toned
`LabelButton`s ("+ NEW SESSION", "+ NEW PROJECT", "GO TO…", "‹ BACK") *do* read as
tappable — accent carries them — but any tappable label rendered dim (Cancel, any disabled
state) falls straight into the inert class.

**Fix:** `LabelButton` always renders the resting track (accent-toned when enabled and
primary-ish, `accentDim` when quiet, and *kept at reduced opacity* when disabled — a
disabled control should look like a dimmed control, not like a caption). "CANCEL"
alternatively becomes `× Cancel` or a trailing `×` (universal five, corner position).
**P2 · S.**

### 3.10 — P2 · Ghost buttons are captions

**What:** `variant="ghost"` (`app/src/ui/button.tsx:46`) is "no box at all, announced by
its label style" — a bare 11pt tracked mono label in ink. Live instances: "REFRESH" on
Devices (`app/app/devices.tsx:166`), "DONE" in the Files info panel
(`app/src/files/info-card.tsx:44`), "TYPE IT INSTEAD" on the scan screen
(`app/src/connect/scan.tsx:71,112`), plus `devices.tsx:131` and `pair-step.tsx:125`.

**Why:** The only thing separating a ghost button from a section marker is one step of ink
(`text` vs `textDim`) — far below a discriminable affordance at 11pt, and exactly the
failure predicted for this aesthetic: label text, marker text and button text share one
style. "REFRESH" on Devices is the sharpest case — it is this screen's reload control
(replacing a ⟳ icon) and it looks like a caption next to the outlined "ADD A COMPUTER".

**Fix:** fold ghost into the track rule at the primitive level: ghost renders its label
plus the 2pt `accentDim` resting underline (accent when pressed). One change in
`button.tsx` fixes every call site, and `LabelButton` (3.9) should then delegate to it so
the app has one quiet-text-button, not two. **P2 · S.**

### 3.11 — P3 · Accent dilution on Files

**What:** Files shows up to three simultaneous accent marks: the active root tab, the
active sort column, and the "GO TO…" header action (`app/app/(tabs)/files.tsx:251`).

**Why:** §3.3 says one selection system per screen and accent only for selection / primary
action / live activity. When accent marks a persistent nav state, a persistent sort state
*and* a rarely-used verb at once, it stops being the reliable "this is the live thing"
signal — which weakens it as the affordance the rest of this audit leans on. Not a
task-blocker; it slows the read of the screen.

**Fix:** keep accent on the root tab (the screen's true selection). The active sort column
drops to full-ink label + caret (the caret already disambiguates); "GO TO…" becomes a
quiet tracked label per the track rule, or `⌕` search-corner treatment (universal five).
**P3 · S.**

### 3.12 — P3 · Smaller instances of the same disease

- "SHOW FULL INPUT ▾" in the approval card (`app/src/agent/session-view.tsx:175`) — dim
  label directly under the inert "APPROVAL NEEDED" label. The `▾` helps; the track rule
  would finish it. **P3 · S.**
- "AWAY FROM HOME  +" disclosure on the connect screen
  (`app/src/connect/onboarding.tsx:88-89`) — a whole-row toggle whose only signal is a
  right-aligned 11pt `+`, amid other inert section labels. Track rule, or `‹ ›`-style
  chevron flip. **P3 · S.**
- Agent "On this PC" groups (`session-list.tsx:239-247`) mix inert group-header rows into a
  list of tappable resume rows — §11.1 forbids mixed lists. The headers are visually
  distinct (label + faint path vs body text), so this is borderline; the hairline placement
  (rules only under the tappable rows) is what keeps it readable. Watch, don't rebuild.
  **P3.**

---

## 4. Verified fine — reported changes that are NOT regressions

Judged on the real code; no fix needed:

- **System tab refresh removal** (`app/app/(tabs)/system.tsx`): the spec's replacement was
  actually built here — auto-poll with backoff, a live "UPDATED 2S AGO" status line, and a
  labelled "Retry" in the failure banner. Pull-to-refresh is a shortcut with a visible
  twin. This is the pattern Agent (3.3) and Files (3.7) should copy.
- **Terminal**: continuous socket, labelled "Reconnect" in the offline banner, RUN as the
  one accent, S/M/L segmented control with proper tracks. No findability loss (keyboard
  exit aside — 3.1).
- **Screen panel-state** (`app/src/screen/panel-state.tsx`): the stranded black box +
  separate red banner is genuinely solved — state name, observed fact, one accent action,
  live countdown, all inside the panel. This is the best screen of the migration.
- **Screen tab dock legibility & selected state**: 11pt tracked mono at 44pt targets is
  legible, and active = accent + 2pt underline is unmistakable *as a mark*. The regression
  is the resting affordance (3.4), not the labels or the selected mark itself.
- **Monitor switching**: tap opens the picker, long-press cycles — a gesture with a
  visible twin, exactly per §11.2 (and an improvement over the old long-press-only route,
  as the commit message claims).
- **Session row Remove**: a visible trailing `×` (universal five, conventional position)
  with an accessibility hint. The spec's own "long-press for Remove" idea was correctly
  *upgraded* to a visible control.
- **Sheets** (`app/src/ui/sheet.tsx`): visible `×` close, backdrop dismiss, and closing
  takes the keyboard down with it — the Go-to-Folder and New-Project flows have proper
  exits.
- **Buttons generally** (suspect #6 in the brief): `primary`/`danger` (solid fills),
  `secondary` (hairline outline) and `subtle` (soft tint) all carry a box or fill and read
  as buttons despite the 11pt mono label. The concern lands only on `ghost` and the ad-hoc
  `LabelButton`/tappable-`Label` pattern (3.9, 3.10).
- **Selection state** (suspect #8): selected file rows get the `accentSoft` band, the
  Files info panel opens under a 2pt accent rule, segmented controls get accent + track —
  at-a-glance sufficient wherever it is actually applied.
- **Tab bar**: icons kept alongside mono labels, selection by accent tint — a deliberate,
  correct trade against the reference's text-only nav.
- **Banner/EmptyState actions** (`app/src/ui/feedback.tsx:240,279`): rendered as `subtle`
  and `secondary` buttons respectively — visible, boxed, findable.
- **`keyboardShouldPersistTaps="handled"`** is set consistently and correctly on every
  scrolling surface with an input — the taps-eaten-by-keyboard failure mode was avoided.
  What is missing is `keyboardDismissMode` and visible exits (3.1), not tap handling.

## 5. Suggested order of work

1. Keyboard exits (3.1): `keyboardDismissMode="interactive"` on the shared `Screen` scroll
   and the five listed lists; `×` trailing the Screen tab's TYPE row; `⌄ hide` key on the
   terminal key bar; blur-on-send in the Agent composer.
2. The track rule into DESIGN.md §11.1 (§2 above) — it is the spec for items 3–6 below.
3. `button.tsx` ghost underline + `LabelButton` folded into it (3.9, 3.10) — one
   primitive, many screens.
4. One-liners: root tabs track (3.5), dock key track (3.4 — also makes TYPE's on-state
   legible for 3.1), sort header track (3.6), path-bar COPY (3.8).
5. Agent list poll + "UPDATED NS AGO" (3.3); Files "AS OF" status line and footer removal
   (3.7).
6. Per-row `⋯` → InfoCard on Files (3.2).
7. P3 polish (3.11, 3.12) opportunistically.

Everything above stays inside the Ledger system: no cards, no pills, no second accent —
just the system's own 2pt track finally telling the truth about what is tappable, and a
visible exit from every state the app can put you in.
