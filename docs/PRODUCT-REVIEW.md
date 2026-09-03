# Tether — Product Review

*A PM's end-to-end review of the app as it stands. Written 2026-08-31 from the actual code
(`app/app/`, `app/src/`, `server/src/`), the repo screenshots, and the docs. I could not run
the app on a phone; wherever a judgement rests only on reading code rather than seeing a
render, I say so. The visual redesign (Swiss/editorial) is assumed to ship, so nothing here
is about colours, spacing, or card styling. The Files media-viewer work is assumed to ship too.*

> **Status update (2026-09-03).** This review is kept as written, but the tree has moved past
> it — most of its top-10 has since landed. Read the findings below as a snapshot of
> 2026-08-31, not as the current state:
>
> - **F1 / ideas 1–2 (attention + notifications): largely landed.** In-app: an attention
>   store polls session status every 3 s and drives an Agent tab badge and a cross-tab
>   "needs you" banner (`app/src/agent/attention-store.ts`, `app/app/(tabs)/_layout.tsx`,
>   `app/src/agent/needs-you-banner.tsx`). Backgrounded phone: the host POSTs to a
>   configurable webhook, ntfy first-class (`server/src/notify.ts`, docs/AGENT.md). The
>   approval timeout is now 30 minutes by default, configurable via
>   `BELAY_APPROVAL_TIMEOUT_MS` (`server/src/agent.ts`) — the "5 minutes" cited below is
>   stale. Still open: the `belay://agent?…` deep link has no handler in the app, and the
>   3 s poll is not yet a push socket.
> - **F2 / idea 5 (pairing dead end): fixed** via `npm start -- --reset-pairing`, which
>   reopens pairing without discarding the host identity (`server/src/reset-pairing.ts`),
>   and the app's code step now explains the situation instead of asking for digits that
>   don't exist (`app/src/connect/no-code-step.tsx`, `app/src/connect/dead-end.ts`). The
>   invite-from-a-paired-device route (G1-iii) was not built.
> - **F3 / idea 4 (tool results): fixed** — `tool-result` events flow to the phone and fold
>   under their tool lines (`server/src/agent-events.ts`, `app/src/agent/feed-model.ts`).
> - **F4 / ideas 3 and 10 (approval card): fixed** — Edits render as real diffs, Writes show
>   content (`app/src/agent/approval-card.tsx`, `server/src/approval-preview.ts`), and
>   "Always &lt;tool&gt;" is replaced by scoped grants with risk tiers and revocable chips
>   (`server/src/approval-scopes.ts`, `app/src/agent/grant-list.tsx`).
> - **F5 (stale session list): addressed** by the same 3 s attention poll (statuses are near-
>   live, not yet pushed).
> - **F6 / idea 8 (amnesiac resume): fixed** — the tail of the Claude-side transcript is
>   replayed into the feed on resume (`server/src/agent.ts` `attachSession`,
>   `server/src/transcript.ts`).
> - **F7 / idea 6 (what changed): fixed** — `GET /agent/sessions/:id/changes`
>   (`server/src/index.ts`, `server/src/changes.ts`) with a phone diff viewer
>   (`app/src/changes/`).
> - **F8 / idea 7 (busy sessions): fixed** — prompts sent mid-turn are queued, cancellable,
>   and an interrupt path exists (`app/src/agent/session.ts`, `server/src/agent-flow.ts`).
> - **F9 / G7 (dictation docs): resolved by removal** — the `/dictate` route and host-side
>   whisper path are gone; voice is on-phone hold-to-talk on the Agent tab
>   (`app/src/agent/mic.tsx`).
> - **F10 (revoke): fixed** — device revocation is wired into the System tab
>   (`app/src/system/paired-devices.tsx`).
> - **Idea 9 (connection chrome): partially landed** — a shared connection-status row with a
>   switch-computer link exists (`app/src/ui/connection-status.tsx`,
>   `app/src/devices/switch-link.tsx`), rendered per tab rather than as one global strip.
>
> Findings not listed above (e.g. F11 first-run landing, F14 dotfiles, F15 cross-tab glue,
> F16 screenshots) have not been re-audited here; treat them as possibly stale too.

---

## 1. Verdict

**This is a genuinely good tool with one great idea, and the great idea is the least finished
part of it.**

The engineering quality is far above hobby-project norm. The failure-state discipline that was
missing in the incidents you remember has largely been retrofitted, and retrofitted well:
`app/src/connect/diagnose.ts` now distinguishes timeouts, refused connections, wrong-port
answers, mixed-content blocks, and proxy interference, each with a specific next step; the
tailnet upgrade in `app/app/index.tsx` retries the 100.x probe several times before it dares
say "Tailscale is off" (a direct fix for the ATS misdiagnosis); the scanned-QR flow races every
address the host knows instead of trusting one. The Terminal tab is honest about pty-vs-pipe.
The System tab keeps showing last-known numbers and *says* they are stale. Whoever wrote the
comments in this codebase understands the "state what you observed, not your conclusion"
principle — in the connect flow it is now mostly practiced, not just preached.

Who is it for? Right now: one technical person controlling one or two of their own machines,
who is comfortable running `npm start` in a terminal. That is fine — that's the honest market
for a self-hosted no-relay tool. Within that market, the Screen, Terminal, Files, and System
tabs are solid, competent, and roughly at parity with what the category expects.

**What it is actually great at:** the pairing/connect experience (QR scan, address racing,
tailnet no-code pairing, real diagnosis on failure) is now *better* than most commercial remote
desktop apps. The security posture is thoughtful and honestly documented.

**Where it falls down, in order of severity:**

1. **The app is deaf when it isn't open.** There are zero notifications of any kind — no push,
   no local, no badge (verified: no notification module anywhere in `app/`). For Screen or
   Terminal that's fine. For the Agent tab it is close to fatal: a Claude session that hits a
   permission ask waits five minutes and then **fails closed to deny**
   (`server/src/agent.ts`, `APPROVAL_TIMEOUT_MS`), and the only way to know it was waiting was
   to already be staring at that session's screen. The product's differentiator — "your
   computer works while you live your life, and pings you when it needs a decision" — does not
   exist. What exists is "your computer works while you watch it," which a laptop already does
   better.
2. **The Agent feed is a keyhole, not a window.** Tool *results* are deliberately dropped
   (`parseClaudeLine` in `server/src/agent.ts` maps everything except assistant
   text/tool-use/result to `[]`), so you see `▸ Bash npm test` and never whether the tests
   passed except through Claude's own narration. There is no way to see a diff — not before
   approving an Edit, not after a turn, not at the end of a session. You are asked to approve
   and review work you cannot inspect from the same screen.
3. **One old dead end is still live.** Once any device is paired, the host never mints a
   pairing code again (`server/src/index.ts:104` — `if (deviceCount() === 0) ensureCode()`),
   and there is no command, keypress, or route to request one. A second phone on plain LAN, or
   a re-paired phone after reinstall without Tailscale, hits a code screen asking for a code
   that cannot exist. This is exactly the failure you lived through, structurally intact.
4. **The five tabs don't know about each other.** Agent edits files you can't jump to in
   Files; a session's project folder isn't a link; the Terminal can't open in the session's
   cwd; nothing anywhere says "Agent needs you" while you're on another tab.

The owner's bar is "everything is easy to find, and the UI and UX are amazing." The connect
flow is close. The Agent tab is a competent v1 of the wrong ambition: it recreates the Claude
Code terminal experience on a small screen, when the phone form factor demands a *supervision*
experience — glanceable status, interrupt-driven attention, decision cards you can act on in
three seconds, and evidence (diffs, outputs) you can review at a coffee queue.

---

## 2. Journey walkthroughs

### 2.1 First-ever setup (cold start, same Wi-Fi)

**What works.** The connect screen (`screenshots/01-connect.png`) is the best screen in the
app: address field with "port 8787 is added for you," a QR path that fills in everything, and
a "Before you connect" checklist with the actual `cd server && npm start` command. The success
card confirms pairing and states "you will not need the code again." The `/health` pre-check
before asking for a code means the user can't waste a code on a dead address. Health checks
are time-bounded (8 s) so the app never just freezes.

**Where it breaks.**
- The journey *before* the app is the hard part, and the app cannot help with it: install
  Node, `npm install`, `npm run build:native`, grant two macOS TCC permissions to *the
  terminal app, not node*, fully quit and reopen the terminal. `docs/SETUP.md` documents this
  gotcha excellently — but a doc is where users end up after failing, not before. The phone
  app's "Before you connect" steps stop at "start the host agent"; they don't mention the
  permission step at all, and the very first thing a fresh Mac user sees after pairing is
  likely a black Screen tab (the app *does* then diagnose it — `CaptureBlocked` in
  `src/screen/parts.tsx` — good recovery, avoidable injury).
- Judgement from code: the redirect logic in `index.tsx` (paired → straight to `/(tabs)/screen`)
  means a first-time user's landing screen is the tab most likely to be broken by permissions.
  Landing on System (always works) or a one-time "you're in — here's what each tab does" beat
  would make the first 30 seconds a success instead of a black rectangle.

### 2.2 Adding a second device / re-pairing (the observed failure)

Open the app on a second phone on LAN, enter the address. `/health` answers `paired: true`.
`PairStep` shows an advisory ("This computer already has another device paired — adding this
one will not remove it," `src/connect/pair-step.tsx:89`) and then asks for six digits. **The
host will never display those digits**: `ensureCode()` runs only when `deviceCount() === 0`,
and nothing else calls `generateCode()` outside tests. There is no `npm run pair-code`, no
keypress in the banner, no authenticated route for an existing device to mint a code for a new
one. Unless both devices are on the same tailnet, this journey terminates at a screen asking
for something that does not exist — with copy that implies it does. This is the single worst
truth-gap left in the product, and it's the one that already burned the owner once.

### 2.3 Connecting from outside the house

**What works.** Genuinely strong. Tailnet identity pairing (no code at all), the automatic
"upgrade to the Tailscale address" during connect, retries before blaming Tailscale, the
`TailscaleCard` with the failure detail attached, the "LAN-only computer" warning banner on My
Computers (`app/app/devices.tsx`), and `describeUrl` telling you which path you're on. The ATS
lesson was learned: `docs/IOS.md` explains exactly why Expo Go can't do 100.x and pushes the
dev build.

**Where it breaks.** Only at the edges: if the host machine sleeps, you get `phase:
'unreachable'` and an honest banner — but recovery is entirely manual ("Try again"). There is
no periodic re-probe, no "I'll keep trying and connect when it answers," and no Wake-on-LAN
even though a second paired computer on the same LAN could send the magic packet for you. A
person standing in a supermarket will tap Try again four times and give up.

### 2.4 Starting a Claude session and approving a tool call

**What works.** Pick a project (recents + a one-level git-repo scan + manual path + create new
folder — good coverage), type or dictate a prompt, watch narration stream in, get an approval
card with tool name, a one-line detail, expandable raw JSON input, and Allow / Deny /
"Always <tool>". Approvals fail closed on every failure mode (timeout, host restart, dead
sidecar) — the security story is genuinely right. Stop works even over REST when the socket is
down. Voice→text lands in the composer for review rather than firing blind. All good decisions.

**Where it breaks, step by step:**
- *You leave the app.* iOS suspends it; the WebSocket dies. Claude asks to run `npm test`.
  Nothing on your phone moves. Five minutes later the ask auto-denies, Claude flounders or
  stops, and you find out whenever you next open the app. **This is the core loop of the
  product's headline feature, and it silently fails on the happy path of phone ownership
  (putting the phone in your pocket).**
- *You stay in the app but on the Terminal tab.* Still nothing: no tab badge, no banner, no
  sound. The `waiting` status is only rendered inside the Agent tab.
- *You are on the Agent tab's session list.* The list fetches once on mount and on
  pull-to-refresh (`session-list.tsx` — `refresh()` has no interval and no socket), so the
  status badges go stale within seconds of being rendered. Three sessions running, one
  waiting: the list may show all three as "working."
- *You approve an Edit.* The card shows the tool name and a truncated `file_path`, plus raw
  JSON (`old_string`/`new_string` mashed into a 2000-char pretty-print). There is no rendered
  diff. For `Bash` you get the command — fine. For `Edit`/`Write`, you're approving a change
  you can't meaningfully read on the phone. Most users will develop the habit the flow
  teaches: tap Allow without reading. That habit defeats the entire approval architecture.
- *"Always Bash".* One tap converts "approve every action" into "approve nothing ever again
  for the highest-risk tool," for the rest of the session, with no scoping (`autoAllow` is a
  per-tool-name `Set` in `server/src/agent.ts`). The safest and the most dangerous Bash
  command are the same tool name.
- *A second approval arrives while one is pending.* The server fails it closed
  ("another approval is already pending") — correct defensively, but with subagents or
  parallel tool use this silently denies work, and the feed's only trace is an info line.

### 2.5 Monitoring, resuming, multiple sessions

- Resuming from "On this PC" works and is a great feature — but the resumed session opens
  with an empty feed and a single "resumed session — context restored on the PC" line
  (`attachSession`). The full transcript exists on disk in `~/.claude/projects/…jsonl`; the
  phone just never sees it. You are asked to continue a conversation you cannot re-read. Same
  problem after a host restart beyond the 400-event cap.
- The "$0.08 · 12s" result line is nice; there is no per-session or per-day total anywhere,
  so cost awareness dies after one turn scrolls past.
- Multiple sessions run fine server-side, but the product gives you no cross-session view of
  *attention*: which needs approval, which errored, which finished while you were away. The
  session list is the only aggregate view and it's stale (above).
- You cannot send a prompt while a turn is running — `sendPrompt` throws "session is busy"
  and the composer nags "stop it first or wait." Claude Code itself supports queued/steering
  messages; from a phone, "queue this thought for when it's done" is exactly the natural
  gesture. Stop is also a blunt `proc.kill()` — no "finish the current tool, then stop."

### 2.6 Finding and reading a file

**What works.** The Files tab is now genuinely competent (`screenshots/05-files.png`): root
chips, breadcrumbs, back/forward/up, per-folder filter, sortable columns, Go-to-Folder sheet
(the missing-path-entry failure is fixed), long-press info card, honest denied-path banner
that explains the allow-list. With the media viewer landing, this tab is close to done.

**Where it breaks.**
- Home root opens sorted by name — which on a Unix home means a wall of dotfiles
  (`screenshots/05-files.png` is literally eleven dotfolders). One default ("hide dotfiles,"
  a toggle to show) would make the first render match what the user thinks their home
  folder looks like.
- Filter is per-folder only. "Find that file whose name I know but location I don't" — the
  most phone-natural file task — has no answer; there's no recursive search route on the
  server either (cheap to add, read-only, same allow-list).
- No way to get a file *off* the PC: no share/AirDrop/save of the bytes you're already
  allowed to read. Read-only ≠ can't export what you can see; the security boundary is the
  allow-list, not the phone's clipboard.

### 2.7 Recovering when the computer is asleep / host not running

Honest, but passive. Devices screen: "Asleep or off" with a red dot; unreachable banner with
"Try again." System tab: keeps last numbers, says how stale they are, backs off its poll —
the best-behaved surface in this scenario. Nothing anywhere retries on your behalf, tells you
*which* address failed, or offers a wake path. `phase` never re-races addresses without a
user action, so a Mac that wakes up stays "unreachable" in the UI until a manual tap.

---

## 3. Findings

Each: what's wrong → why it matters → evidence. (V) = judged from a screenshot; otherwise from code.

**F1 — No notification of any kind, ever.**
The approval flow means the machine *stops and waits for you*, then auto-denies at 5 minutes.
Without at least a local heads-up when the app is backgrounded, the Agent tab only works as a
foreground toy. Evidence: no notifications module in `app/` (grep), `APPROVAL_TIMEOUT_MS` in
`server/src/agent.ts`. *Honest constraint: true remote push needs a push server, which
collides with "no third-party relay." See idea A1 for the honest menu of options.*

**F2 — Paired host can never issue a pairing code again.**
`server/src/index.ts:104` gates `ensureCode()` on `deviceCount() === 0`; nothing else mints
codes. The app's own pair screen (`src/connect/pair-step.tsx:89`) implies adding a second
device is normal. Dead end for any second device off-tailnet; the previously observed field
failure, still in place.

**F3 — Tool results are discarded before the phone ever sees them.**
`parseClaudeLine` (`server/src/agent.ts`) returns `[]` for tool results. The feed shows what
Claude *intends* and what Claude *says*, never what the machine *did*. You cannot verify "the
tests passed" or "the build failed with X" without switching to Terminal and re-running.

**F4 — Approval card asks for consent it doesn't equip you to give.**
Edits/Writes show raw truncated JSON, no diff (`session-view.tsx` `agent-ask` card;
`toolDetail` in `server/src/agent.ts` reduces an Edit to its file path). "Always <tool>" is
per-tool-name with no scoping (`autoAllow: Set<string>`). The UI trains reflexive Allow.

**F5 — Session list statuses are a snapshot, not a feed.**
`SessionList.refresh()` runs on mount and pull only. With one session open in the foreground
consuming `/ws/agent`, the list has no live source at all. "Which of my three sessions needs
me?" is unanswerable, and the badges actively mislead by showing stale states as current.

**F6 — Resumed sessions open amnesiac.**
`attachSession` pushes only a marker event; the Claude-side transcript on disk is never read.
The doc (`docs/AGENT.md`) discloses this ("The old transcript isn't replayed") — documented
is better than hidden, but the product asks you to continue conversations you can't re-read.

**F7 — No "what changed" review anywhere.**
No diff route on the server (route list, `server/src/index.ts`), no git status surface, no
per-turn changed-files summary. The read-only Files API could legitimately serve a diff — it
reads, it doesn't write — so this is unexposed capability, not a security trade-off.

**F8 — Busy sessions refuse input instead of queueing it.**
`sendPrompt` throws "session is busy — wait or stop it first"; composer disables. The natural
phone gesture — fire a thought and pocket the phone — is rejected at exactly the moment it's
most valuable.

**F9 — Documented dictation feature does not exist in the UI.**
`docs/AGENT.md` ("Dictation (Screen tab): hold the mic next to the text box…") and the README
table promise Screen-tab dictation via `/dictate`. The Screen tab imports no mic; `MicButton`
and `useVoice` are used only in `agent/session-view.tsx`, and only with `/transcribe`. The
`/dictate` route sits on the server unused by any client. A user who reads the docs will hunt
for a mic that isn't there.

**F10 — Unsurfaced server capability.**
`GET /windows` + `POST /windows/focus` (list the host's open windows, bring one forward) —
used by the desktop client only; on the phone, where "bring the browser to the front before I
look at the screen" is a killer 2-second interaction, it's absent. `POST /devices/revoke`
exists and `api.revokeDevice` is written, but the System tab's paired-devices card says
"Revoke a device from the Tether window on the computer itself" (`src/system/cards.tsx:110`)
— the UI claims the capability doesn't exist while the client code for it sits one file away.

**F11 — First-run lands on the tab most likely to be broken.** (V + code)
`index.tsx` redirects a fresh pair to `/(tabs)/screen`; on a Mac without TCC grants that's the
black-rectangle screen (`screenshots/03-screen.png` shows the genre: a giant black stage with
"No picture from the host," a red "Stream problem" banner at top, and dead zoom controls on a
picture that will never come — the zoom pill is hidden only when *permissions* are known to
block, not when the display is simply absent). The dead space between banner and stage in that
screenshot is the "ugly" the owner reacted to; layout-when-empty needs design attention even
after the restyle.

**F12 — No global connection/attention chrome.**
Each tab renders its own header and its own connection state; there's no persistent strip
saying which computer you're on, whether it's live, and whether anything needs you. Switching
computers requires knowing that the route lives *behind* the tabs (My Computers is only
reachable by being redirected to it, or via System → nothing — actually there is no in-tabs
link to `/devices` at all except the redirect guard; a connected user who wants to switch
machines has no visible path. Judged from code: no `router.push('/devices')` exists under
`app/app/(tabs)/` outside the guard redirect).

**F13 — System tab hides "switch computer," buries "add computer," and duplicates Appearance.**
Appearance is configured on both the Connect screen and System; switching/forgetting live in
different places (Devices screen has Forget; System has "Disconnect this device" which is also
forget). Small, but it's the kind of "where does that live?" incoherence the owner's bar
forbids.

**F14 — Home directory listing defaults to a dotfile wall.** (V)
`screenshots/05-files.png`. Sorting folders-first by name with no hidden-file filter makes the
first Files render read like `/etc`. One toggle fixes it.

**F15 — The terminal's `claude` quick keys are the only Agent↔Terminal bridge, and nothing
links Agent↔Files.**
A session card shows `cwd` as dead mono text (`session-list.tsx`). "Open this folder in
Files," "open a Terminal here," "view the file Claude just edited" — none exist. Every one is
a one-liner of navigation glue on top of existing capability.

**F16 — Screenshots/docs drift.**
`screenshots/` has no Agent tab image at all (01–06 skip it) even though it's the headline
feature in the README table; 02-pair predates current flows. Minor, but the repo's shop
window undersells the differentiator.

---

## 4. Ideas, prioritised

### Top 10 overall

| # | Idea | Area | Effort | Impact |
|---|------|------|--------|--------|
| 1 | **Attention system: tab badge + live session list + global "needs you" banner** (A1a) | Agent | M | The feature's premise starts working inside the app |
| 2 | **Background notifications for approvals/completions** (A1b — honest options below) | Agent | L | The feature's premise works with the phone in your pocket |
| 3 | **Render diffs in the approval card and feed for Edit/Write** (A2) | Agent | M | Consent becomes informed; Allow-reflex broken |
| 4 | **Stream tool results into the feed (collapsed, expandable)** (A3) | Agent | S–M | You can finally see what the machine did |
| 5 | **Fix the paired-host code dead end** (G1) | UX | S | Kills the worst remaining trap; it already bit once |
| 6 | **"What changed" per turn: git-diff route + phone diff viewer** (A4) | Agent | M | Review work from the coffee queue; the missing half of supervision |
| 7 | **Queue prompts while running; graceful interrupt-with-message** (A5) | Agent | M | Phone-natural fire-and-forget; stops the Stop-hammer |
| 8 | **Load transcript history on resume/attach** (A6) | Agent | S–M | Resumed sessions stop being amnesiac |
| 9 | **Persistent connection header + in-tabs path to My Computers** (G2) | UX | S | "Which machine am I on, is it alive, how do I switch" — always one glance |
| 10 | **Scoped approvals: "always this command," "always in this folder," risk-tiered card** (A7) | Agent | M–L | Approval fatigue drops without opening the barn door |

### 4a. General UX ideas

**G1 — Fix the second-device pairing dead end. (S, high)**
Three compounding fixes, cheapest first: (i) the app already knows `paired: true` from
`/health` — when the host is paired and tailnet pairing didn't kick in, *say so* on the code
step: "This computer only shows a code before its first device pairs. To add this phone:
[the actual options]." Stop asking for digits that don't exist. (ii) Host side: `npm run
pair-code` (or pressing `p` in the banner) mints a fresh 5-minute code on demand. (iii) Best:
an authenticated `/pair/invite` route so an *already-paired* device can display a QR that
enrols the new phone — pairing a second device by pointing it at your first. The security
model already trusts a paired device with total machine control; letting it sponsor a peer
adds nothing to the attack surface.

**G2 — Persistent connection chrome. (S, high)**
One thin strip (or a tappable element in each tab header, since a global bar fights the
redesign): computer name · liveness dot · path (LAN/Tailscale), tapping → My Computers.
Today there is literally no navigational path from the tabs to the device list (F12). Also
collapse the Appearance duplication (F13) into one Settings location.

**G3 — First-run success path. (S–M, high)**
(i) Land a first-ever pair on System (always works) or show a 3-line "you're in" interstitial
with per-tab one-liners. (ii) Put the macOS permission step into the phone's "Before you
connect" checklist — it is the #1 failure per the docs' own admission. (iii) When Screen is
capture-blocked on first run, the CaptureBlocked card already explains; make sure that state,
not the black stage + separate error banner (F11), is the whole layout — one message, one
action, no dead rectangle. *(Layout behaviour, not styling — in scope despite the redesign.)*

**G4 — Auto-recover from "unreachable." (S–M, high)**
Background re-probe with backoff while on the Devices screen or any tab shows unreachable;
connect the moment the host answers, with a "reconnected" haptic. Add Wake-on-LAN as a
stretch: the host records its own MAC at pair time; any *other* paired computer on that LAN
(or the phone itself on Wi-Fi) sends the magic packet — "Wake it up" button instead of a
shrug.

**G5 — Files: hide dotfiles by default (toggle to show); recursive filename search
(server route, same allow-list, read-only); share/save a viewed file via the iOS share
sheet. (S each, medium-high)**
Also: "Open in Files" from any path the app shows elsewhere (agent cwd, terminal cwd) — see
A8.

**G6 — Surface the windows API on the phone. (S, medium)**
A "Windows" sheet on the Screen tab listing the host's open windows (`GET /windows`), tap to
focus (`POST /windows/focus`). Turns "pan/zoom around a 27-inch desktop hunting for Xcode"
into two taps. The routes exist and are tested; this is pure UI.

**G7 — Ship the documented dictation, or delete the docs. (S, medium)**
Either add the mic to the Screen tab's type-row wired to `/dictate` (all pieces exist:
`MicButton`, `useVoice`, the route) or strip it from `docs/AGENT.md`/README. A documented
feature users can't find is worse than an absent one.

**G8 — Device management truthfulness. (S, low-medium)**
Wire `api.revokeDevice` into the System tab's device list (it's written and unused) and
delete the caption claiming revocation requires the computer. Show "this phone" labelled in
the list.

**G9 — Update the repo shop window. (S, low)**
Add Agent-tab screenshots (list, live session, approval card) to `screenshots/` and the
README. The differentiator is currently invisible in the repo.

### 4b. Agentic coding orchestration ideas

*The frame: on a phone, this is not a coding tool — it is a **supervision** tool. The user's
attention is the scarce resource. Everything below optimises for: know when you're needed,
decide in seconds with real evidence, review outcomes without a laptop, and trust the thing
enough to pocket the phone.*

**A1 — The attention system. (the #1 and #2 ideas above)**
- **(a) In-app (M):** a `/ws/agent-list` socket (or 5 s poll) feeding: live status badges on
  the session list; a numeric badge on the Agent tab icon (`waiting` count); a one-line
  interactive banner on *every* tab when any session is waiting — "Session *tether* wants to
  run `npm test` — Allow · Deny · View." Approvals answerable from the banner and from the
  session list without opening the session.
- **(b) Backgrounded phone (L, requires honesty):** self-hosted push is genuinely hard on iOS
  — APNs requires a server Apple can reach. The honest menu: (1) **ntfy or a self-hostable
  push gateway** — still a relay, but the *user's own* relay carrying only "session X needs
  you," no content; (2) an **opt-in Tether-operated push relay** carrying an opaque session id
  — smallest possible trust delta, clearly disclosed; (3) **Live Activities** — start one when
  a prompt is sent; it survives backgrounding and can show status on the lock screen, updated
  while the app has any execution window (limited without push, but real); (4) **critical
  fallback:** raise `APPROVAL_TIMEOUT_MS` and make timeout behaviour visible-and-configurable
  ("asks wait up to 30 min; unanswered = deny"), so a pocketed phone loses minutes, not the
  session. Ship (a)+(3)+(4) first; offer (1)/(2) as an explicit setting with the trade-off
  stated in the UI. Do not pretend the no-relay principle and background push coexist for
  free — say it in Settings the way the README says it about HTTP.

**A2 — Informed consent: diff-first approval cards. (M)**
For `Edit`: render old→new as a proper unified diff (the input already contains both
strings). For `Write`: show the head of the new content with a "replaces existing file
(N lines)" warning when it does. For `Bash`: mono, syntax-hinted, full command *always*
visible (not behind "show full input"). Add a risk tint: destructive patterns
(`rm -rf`, `git push --force`, `sudo`, writes outside cwd) get a visually louder card and a
confirm-hold instead of a tap. This is the difference between an approval system and an
Allow button with extra steps.

**A3 — Show the machine's answers. (S server + S phone)**
Stop dropping tool results in `parseClaudeLine`: emit a `tool-result` event (truncated, e.g.
2 KB, with exit code for Bash) and render it collapsed under its `▸ tool` line, tap to
expand. Sub-idea: the `✗ failed` result row should carry the tail of stderr, which the server
already collects (`stderrTail`) but only surfaces on process death.

**A4 — "What changed": per-turn and per-session review. (M)**
Server: `GET /agent/sessions/:id/changes` running `git status --porcelain` + `git diff`
(and `diff HEAD`) in the session cwd — read-only, no new trust needed. Phone: a "Changes"
button on the session header → changed-file list → per-file diff viewer (share with A2's
renderer). Stretch (L): "checkpoint" chips per turn using the commit-or-stash the CLI already
tends to leave, so you can eyeball *this turn's* delta, not the whole run. This completes the
loop: prompt → watch → approve → **verify** — today verification requires a laptop, which
means the product never quite lets go of the desk.

**A5 — Queue and steer instead of refuse. (M)**
While `running`: composer stays enabled, sends land in a visible "queued — sends when this
turn ends" chip (server holds one pending prompt per session and feeds it on `done`). Add
"Interrupt" as distinct from Stop: deny-current-ask + inject the message, mapping to the
CLI's steering input, so "no — stop touching the tests, fix the import instead" is one
gesture, not Stop→wait→retype.

**A6 — Resume with memory. (S–M)**
On attach, parse the tail of the Claude-side `.jsonl` (the discovery code in
`server/src/discover.ts` already finds and previews these files) into feed events — even
just the last N user/assistant turns — so a resumed session shows the conversation you're
resuming. Add "Load earlier" pagination for the same reason after the 400-event cap bites.

**A7 — Scoped, legible auto-allow. (M–L)**
Replace "Always Bash" with choices scoped to what was actually asked: "Allow *this exact
command* always," "Allow `npm *` in this project," "Allow all Reads." Show the active
allowances as removable chips on the session view so trust granted is trust visible. Persist
per-project (not just per-session) as an explicit opt-in — the current in-memory-only reset
is safe but makes every session start with an approval hailstorm, which is what drives
people to the Always button in the first place.

**A8 — Cross-tab glue for sessions. (S)**
Session card/cwd → "Open in Files" and "Terminal here" (terminal accepts an initial cwd —
server change is trivial). File paths in feed events (tool detail is usually a path) become
tappable → Files viewer. After A4, "view file" from a diff too.

**A9 — Session cost/utilisation ledger. (S)**
Sum `costUsd`/`durationMs` per session (the events already carry them); show "$1.42 · 9 turns
· 41 min" on the card and list. Cheap, and it answers the question every agent user asks at
the end of the week.

**A10 — Multi-session mission control. (M, after A1a)**
Once statuses are live, the session list becomes a real dashboard: sort by
needs-attention-first, group running/waiting/idle/error, swipe to approve/deny the pending
ask, and a compact "all quiet" state. This is the screen that makes running four sessions
feel like managing a team rather than juggling four chat apps.

**A11 — Notification-to-action depth (stretch, after A1b). (M)**
Actionable notifications: Allow/Deny buttons on the lock-screen notification for low-risk
asks (Read/Glob), View-only for risky ones. This is where the product's promise fully lands:
the Mac asks, the wrist answers.

### Effort/impact summary for the agent stack
Ship order that compounds: **A3 → A1a → A2 → A4 → A5/A6 → A7 → A1b → A10/A11.** A3 first
because every later surface (approval card, diffs, notifications) is better when results
exist in the event stream.

---

## 5. What I would cut

- **The web build as a user-facing target.** README lists "runs in a browser (same UI) ✅ —
  used for automated tests." Keep it exactly for tests; stop presenting it as a product
  surface. Mixed-content diagnosis code (`mixedContentHint`) exists solely to explain a
  platform the product shouldn't recommend; the doc surface should say "phone + desktop
  client" and move on.
- **The per-folder "Filter this folder" input as a permanent fixture.** It occupies a full
  row on every Files render (screenshot 05) for a niche action. Fold it into the sort header
  or behind a search icon — especially once real recursive search (G5) exists, which
  supersedes it.
- **The dictation *docs*, today** (G7): until the mic ships on the Screen tab, the paragraphs
  in `AGENT.md`/README are a promise the app breaks. Cut or ship; either is fine.
- **"Always <tool>" in its current form** — replace, don't keep alongside A7. Two allow
  systems is worse than one.
- **The zoom pill on an empty stage** (F11): it already hides for permission-blocked; hide it
  whenever there's no frame. Controls on a picture that doesn't exist are the "ugly" the
  owner saw, as much as any colour was.
- **The duplicated Appearance card** on the Connect screen (keep the System one, or a single
  Settings sheet). Two homes for one setting is one too many.
- **`docs/CHECKLIST.md` from the repo's public story.** It's an internal artifact ("the spec
  you pasted with /goal did not survive…") that reads as scaffolding. Keep it if it's a
  working doc; unlink it from the README's docs list.
- Nothing else. Notably, I would **not** cut the desktop client, virtual-monitor, or seamless
  windows: they're differentiated, documented, and don't tax the phone UX. And I would not
  relax the read-only file API — every capability this review asks for (search, diff, share)
  fits inside reading.

---

## Appendix: judgement provenance

- **From screenshots (V):** first-connect layout quality; black-stage-plus-banner emptiness;
  Files dotfile wall; System tab quality; absence of Agent imagery.
- **From code only:** all Agent-tab behaviour (no Agent screenshot exists); notification
  absence; pairing-code issuance; session-list staleness; tool-result dropping; connection
  lifecycle. I did not run the iOS app or the host; the host on port 8787 was left untouched.
- **Uncertain:** exact iOS background-socket lifetime (assumed standard suspension); whether
  the Claude CLI's stream-json mode accepts mid-turn steering input in the installed version
  (A5's "Interrupt" needs a spike); Live Activity update limits without push (A1b-3 needs a
  spike).
