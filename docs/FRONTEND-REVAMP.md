# Belay Frontend Revamp — Research & Proposal

*A design + frontend proposal, not a rebuild. The rebuild is a later step the founder approves.
Written from the current code (`app/app/`, `app/src/`, `app/src/theme.ts`), `docs/DESIGN.md`, and
`docs/PRODUCT-REVIEW.md`. Nothing here changes the color scheme or the type scale — those are
treated as fixed and are cited from `theme.ts` throughout.*

> **Scope guard.** This document does **not** touch the Screen tab or `app/src/screen/*` — those
> files are being actively edited elsewhere. The stream-overlay section below is written as a
> proposal *for the Screen-tab owner to consider*, from the tab's public behaviour and the
> references, not from re-reading the live files.

---

## 1. The current design language ("Ledger")

Belay already has a real, opinionated design system, documented in `docs/DESIGN.md` and codified
in `app/src/theme.ts`. The revamp keeps all of it. Summary of what exists today:

### 1.1 Colour — two palettes, one language (KEEP EXACTLY)

The system is theme-aware: light is "paper" (warm grey ground, near-black ink), dark is "ink"
(the same page in negative). A single burnt-orange accent is the whole identity. From
`theme.ts`:

| Role | Light (`lightPalette`) | Dark (`darkPalette`) | Use |
|---|---|---|---|
| `bg` | `#EAE8E4` | `#121110` | page ground |
| `surface` | `#F2F1EE` | `#1A1917` | inputs only |
| `surfaceAlt` | `#E1DED9` | `#232120` | recessed: keys, tracks, pressed rows |
| `border` | `#C8C4BD` | `#2E2C29` | hairlines |
| `borderStrong` | `#8F8A82` | `#4A4741` | emphasis rules |
| `text` | `#161513` | `#ECEAE6` | ink |
| `textDim` | `#4F4B45` | `#A9A49C` | secondary |
| `textFaint` | `#615C55` | `#928D84` | tertiary |
| `accent` (text-safe) | `#B03700` | `#FF5C1A` | the one accent, text |
| `accentGraphic` (marks) | `#DE4400` | `#FF4D00` | dots/fills/underlines ≥3pt |
| `good / warn / bad` | `#0B6040 / #754C04 / #A82028` | `#3DDC97 / #F7B32B / #FF7A70` | status |
| `machine` | `#0C0B0A` | `#0C0B0A` | terminal/video ground, near-black in **both** themes |

Plus the `*Soft` translucent fills and their matching `on*Soft` text colours, all WCAG-verified
(the verifier lives in `docs/DESIGN-TOKENS.md §9`). **Do not change any hex or alpha.** Every
new component in this proposal is expressed only in these roles.

### 1.2 Typography — type *is* the hierarchy (KEEP EXACTLY)

From `type` in `theme.ts`: `display` 40/900, `title` 28/900 uppercase, `heading` 19/800,
`subheading` 16/700, `body` 15/400, `caption` 13/400, `numeral` 34/800 tabular, and the
most-used variant `label` — mono, 11pt, uppercase, `letterSpacing: 1.5`, never bold. `micro`
(10pt mono) is the tab-bar/eyebrow voice. Structure comes from typography + hairline rules +
the 4pt spacing scale (`space`), **not** cards — the card is explicitly dead
(`radius.lg = 0`, elevation is a flat no-op shim).

### 1.3 Layout & motion (KEEP)

Square corners (`radius.xs = 2`, `sm = 4` on keys only), strict 4pt spacing, a 20pt page
`margin`, 52pt `rowHeight`, `hairline` rules, 44pt min touch target. Motion is "small, fast,
honest": ease-out only, nothing over `slow` (240ms), presses are opacity (`pressOpacity 0.55`),
not scale. `useReducedMotion()` gating is mandated.

### 1.4 Structure — five tabs + a connect/devices layer

- **Connect** (`app/app/index.tsx`) — first run: address → 6-digit code, with onboarding
  (`connect/onboarding.tsx`), QR scan, tailnet upgrade, and real failure diagnosis
  (`connect/diagnose.ts`). Genuinely the strongest screen in the app.
- **My Computers** (`app/app/devices.tsx`) — the multi-machine picker: dot + status word per
  row, forget/add, tailnet discovery.
- **Five tabs** (`app/app/(tabs)/`): Screen, Agent, Terminal, Files, System — hand-drawn stroke
  glyphs, mono micro-labels, selection carried by accent tint alone.

The engineering discipline is high: `connection.tsx` races addresses, guards against stale
connect attempts, and reports `unreachable` as an honest state rather than hiding behind a
spinner.

---

## 2. Where it is NOT user-friendly

Grounded in the code and `docs/PRODUCT-REVIEW.md`. The visual system is good; these are
**UX/state** problems — the app is, in several places, *quiet or dishonest about what is true
right now*.

1. **The Agent tab renders a blank screen with no connection.** `app/app/(tabs)/agent.tsx:26`
   is literally `{!connection ? null : …}` — no EmptyState, no "not connected" message. A
   dead-end blank rectangle.
2. **Status badges go stale and lie.** The Agent session list fetches once on mount + pull-to-
   refresh, with no interval or socket (`session-list.tsx`). Three sessions running, one
   waiting on an approval → the list can show all three as "working." This is the literal
   "controls that lie about their state" complaint.
3. **First run lands on the tab most likely to be broken.** Paired users are redirected
   straight to `/(tabs)/screen`; a fresh Mac user who hasn't granted TCC permissions sees a
   black Screen tab as their *first* impression (recovery via `CaptureBlocked` exists, but the
   injury is avoidable).
4. **The re-pairing dead-end is still live.** An already-paired host never mints a new code
   (`server` side), yet `pair-step.tsx` still presents six code boxes and copy implying a code
   is on screen. A second LAN phone asks for a code that cannot exist. The `dead-end.ts` +
   `no-code-step.tsx` machinery mitigates this, but the trap surface still exists.
5. **Cross-tab attention is invisible.** "Agent needs you" only renders inside the Agent tab
   (plus the tab badge). On Terminal/Files/System, a pending approval that fails-closed in 5
   minutes is silent.
6. **Recovery from `unreachable` is entirely manual.** `phase: 'unreachable'` shows an honest
   banner with "Try again," but there is no auto re-probe / "connect when it wakes." A user in
   a supermarket taps Try again four times and quits.
7. **Approval cards ask you to approve what you can't read.** Edit/Write approvals show raw
   `old_string`/`new_string` JSON, no rendered diff — teaching the "tap Allow without reading"
   habit that defeats the whole approval model.
8. **Connection status has no single, glanceable home.** Each tab re-derives "am I connected?"
   locally; there is no persistent, consistent status affordance the way every reference app
   has one.

---

## 3. Reference frontends & the patterns worth borrowing

Five well-regarded remote-control/streaming clients. For each, the *specific, borrowable* pattern
— translated into Ledger terms (no colour/type change).

### 3.1 Parsec (game streaming)
- **Persistent computer list as home, with a live per-machine state chip** ("Online / Sleeping /
  Offline"). The list *is* the app; connecting is one tap. Belay's `devices.tsx` is already this
  shape — the borrow is making the state chip *live and always-trusted*, never stale.
- **A single, unobtrusive in-stream overlay handle** (a small tab you pull for settings/keyboard/
  disconnect) instead of persistent chrome over the video. Maps to Belay's autohide dock.
- **Connection quality surfaced continuously** (latency/bitrate) so the user always knows the
  link is alive — the antidote to Belay's "is it frozen or slow?" ambiguity.

### 3.2 Moonlight (open-source streaming, Sunshine host)
- **Explicit pairing state machine with a numeric PIN** shown host-side and typed client-side —
  the same model Belay uses. Moonlight's win is that the client **greys/hides hosts that can't
  be paired right now** rather than letting you start a doomed flow. Direct fix for Belay's
  dead-end #4: don't present code boxes when a code cannot exist.
- **Per-host "add manually" vs "auto-discovered" split** in one list — Belay already has
  `DiscoveredSection`; the borrow is the visual consistency between saved and discovered.

### 3.3 Steam Link (Valve)
- **A guided one-time "test your setup" step** before first real use (network check with a
  pass/fail and a fix). Belay should run a capability/permission pre-flight so the *first* screen
  after pairing is a success, not a black Screen tab (#3).
- **Big, forgiving touch controls and a mode switch** (controller vs touch) surfaced up front,
  not buried.

### 3.4 Jump Desktop (RDP/VNC/Fluid) — the gold standard for *control* UX
- **Explicit, switchable input modes** (Standard / Trackpad / Pen / Locked) with an obvious
  on-screen switcher, confirmed in their docs. Belay's Screen tab has scroll-mode/mods/pinch
  logic already; the borrow is making the *current mode legible and one-tap switchable* in the
  overlay rather than gesture-only.
- **Device list with per-machine status and unattended-access indicators.** Clear "this machine
  is reachable / needs setup" states.
- **A compact floating toolbar** that collects keyboard, modifier keys, mode, and disconnect —
  the reference for a cleaner Belay stream overlay.

### 3.5 Tailscale mobile + Blink Shell (honourable mentions for *state honesty*)
- **Tailscale**: a single always-visible connection state with a plain-language reason when
  down ("Not connected — VPN is off"). This is the model for Belay's proposed persistent status
  pill (#8).
- **Blink Shell**: terminal-first app that never leaves you guessing whether the session is live
  — a persistent connection dot + reconnect affordance. Matches Belay's Terminal honesty goal.

**Cross-cutting lesson from all five:** the best remote-control apps make *connection state and
input mode continuously legible* and *never start a flow that can't succeed*. That is exactly
Belay's gap — the visual system is already ahead of most of these.

---

## 4. Screen-by-screen proposal (colour & type unchanged)

Everything below is expressible in existing `theme` roles and `type` variants. New shared
components are small and live in `app/src/ui/`.

### 4.1 New shared primitive: `ConnectionStatus` (persistent, honest)

A single source of truth for "what is true right now," rendered consistently. Not a new colour —
uses `Dot` + `label`:

- **Connected** → `good` dot + `label` "CONNECTED · <machine>" + faint transport (`describeUrl`
  already exists in `devices.tsx`: "Tailscale" / "your local network").
- **Connecting** → `accentGraphic` pulsing dot + "CONNECTING…".
- **Unreachable** → `bad` dot + "ASLEEP OR OFF" + inline "Retry / Auto-reconnect" affordance.

Placed as a slim header row on every non-stream tab (Agent/Terminal/Files/System) and as the
`devices.tsx` status line. This replaces per-tab ad-hoc derivation and kills #8.
**Size: medium.** (New `ui` component + adoption in 4 tabs; no screen-tab changes.)

### 4.2 Agent tab — fix the blank screen + stale badges (highest impact)

- **Never render `null`.** When `!connection`, show an `EmptyState` ("Not connected — pick a
  computer to run agents on", action → `/devices`). Kills #1. **Size: small.**
- **Live session status.** Drive the session list from the existing attention store/socket
  instead of mount-only fetch, or add a short poll while the tab is focused, so a "waiting" badge
  can never sit behind a stale "working." Kills #2. **Size: medium** (data wiring; the store
  already exists — `useAgentAttention` is mounted in `_layout.tsx`).
- **Decision-card supervision model** (borrow Parsec/Jump glanceability): a waiting approval is a
  full-width `Banner` (status `accent` = "decide", per the existing tab-badge convention — accent
  not red), tool name as `subheading`, one-line detail, and for Edit/Write a **rendered diff**
  (added lines on `goodSoft`, removed on `badSoft`, using the existing soft fills). Fixes #7.
  **Size: large** (diff renderer is real work; propose as its own phase).

### 4.3 Connect / onboarding — make the first 30 seconds a success

- **Pre-flight after pairing** (borrow Steam Link 3.3 + Moonlight): before redirecting to a tab,
  run the capability check (`native` capture/input is already known from `/health` — see
  `pair-step.tsx`'s `CapabilityNote`). If capture isn't available, **land on System** (always
  works) with a one-line "Screen control needs a permission on your Mac — here's how," instead of
  a black Screen tab. Fixes #3. **Size: medium.**
- **Add the missing TCC permission step** to `onboarding.tsx`'s `SetupSteps` (currently stops at
  "start the host agent"). **Size: small.**
- **Close the re-pairing dead-end at the UI** (borrow Moonlight 3.2): when `dead-end.ts` detects
  the trap, the code boxes should not be the primary affordance at all — lead with the
  `no-code-step.tsx` recovery (the exact host commands / tailnet path), and demote the code entry
  to a labelled fallback. The detection already exists; this is about *ordering and emphasis* so
  we never present a code field as the main action when a code can't exist. Fixes #4.
  **Size: small–medium.**

### 4.4 My Computers (`devices.tsx`) — trustworthy live states + auto-reconnect

- Adopt `ConnectionStatus` semantics for the per-row dot (already close). Ensure the status word
  can never be stale relative to `useReachability`.
- **Auto-reconnect affordance** (borrow Parsec/Jump unattended): when `phase === 'unreachable'`,
  offer "Keep trying" that re-probes on a backoff and connects when the machine wakes, replacing
  the manual four-taps-and-quit loop (#6). The System tab already implements a backoff for stats
  polling — reuse that pattern. **Size: medium.**
- Keep the excellent forget-confirmation `Sheet`, LAN-only warning, and tailnet `DiscoveredSection`
  as-is.

### 4.5 Cross-tab attention (`_layout.tsx`) — extend, don't relocate

- The Agent tab badge (`waitingCount`) and `NeedsYouBanner` already exist. The borrow is making
  the banner's reach explicit and consistent: a persistent, dismissible "Agent needs you"
  affordance visible from any tab (it already mounts at the layout level — verify it renders over
  Terminal/Files/System, not just Agent). Fixes #5. **Size: small.**

### 4.6 Stream overlay (Screen tab) — PROPOSAL ONLY, for the tab owner

*Not implemented here; the Screen tab and `app/src/screen/*` are owned/edited elsewhere.*
Borrowing Jump Desktop (3.4) + Parsec (3.1):

- **One collapsing floating toolbar** instead of scattered chrome: mode switch (Trackpad /
  Direct-touch / Locked — Belay already has scroll-mode/pinch/mods logic), keyboard, modifier
  keybar, monitor picker, and disconnect, collected into a single autohide dock with a visible
  pull-handle (the dock/autohide machinery already exists).
- **Current input mode is always legible** — a mono `label` in the dock ("TRACKPAD") so the user
  never wonders why a tap didn't click (Jump's core lesson).
- **Continuous link-quality glyph** (a small `accentGraphic` indicator) so a laggy stream reads
  as "slow," not "frozen" (Parsec).
- **On `CaptureBlocked`, a full recovery card** (this already exists — keep it) with the exact
  macOS permission path.
All expressible in `machine`/`onMachine`/`onMachineDim` + `accentGraphic`, no new colours.

---

## 5. Prioritised change list (highest → lowest user impact)

| # | Change | Impact | Size | Touches screen tab? |
|---|---|---|---|---|
| 1 | Agent tab: replace blank `null` with an EmptyState + link to devices | **Critical** | Small | No |
| 2 | Live (non-stale) Agent session status badges | **Critical** | Medium | No |
| 3 | `ConnectionStatus` primitive, adopted on all non-stream tabs | High | Medium | No |
| 4 | Pre-flight after pairing → land on a working tab, not a black Screen | High | Medium | No |
| 5 | Close the re-pairing dead-end in the UI (lead with recovery, demote code field) | High | Small–Med | No |
| 6 | Auto-reconnect ("keep trying") on `unreachable` | High | Medium | No |
| 7 | Cross-tab "Agent needs you" reaches every tab | Medium-High | Small | No |
| 8 | Add the TCC-permission step to onboarding | Medium | Small | No |
| 9 | Rendered diff in Edit/Write approval cards | Medium-High | Large | No |
| 10 | Stream-overlay consolidation (single autohide toolbar + legible mode) | High* | Large | **Yes — owner's call** |

\*High impact but deferred to the Screen-tab owner per the scope guard.

**Suggested sequencing:** ship #1, #5, #7, #8 first (all small, all high-value, zero screen-tab
risk), then #2/#3/#4/#6 (the state-honesty core), then #9, then coordinate #10 with the Screen-tab
owner.

---

## 6. Component / layout sketch

New `app/src/ui/` primitives (small, single-purpose, per the many-small-files rule):

```
ui/
  connection-status.tsx   # <ConnectionStatus phase machine transport /> — Dot + label, one truth
  approval-card.tsx       # <ApprovalCard tool detail diff onAllow onDeny /> — Banner(accent) + diff
  diff-view.tsx           # added → goodSoft, removed → badSoft, mono; no new colours
  reconnect-banner.tsx    # <ReconnectBanner onKeepTrying /> — wraps the backoff loop
```

Tab shell (non-stream tabs), all existing roles:

```
<Screen>
  <ConnectionStatus />          // good/accent/bad Dot + mono label — always honest
  <Rule />
  … tab content …
  // if !connection: <EmptyState> instead of blank
```

No changes to `theme.ts`, `radius`, `space`, `type`, or any palette value. The revamp is a
*state-honesty and information-architecture* pass wearing the existing Ledger clothes — which is
exactly what the references teach and what the product review says is missing.
</content>
</invoke>
