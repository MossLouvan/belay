# The Agent tab

Drive Claude Code sessions on your PC from your phone — from anywhere, over
Tailscale — with every action gated on an Allow/Deny tap.

```
  iPhone (Agent tab)                       PC (Belay host)
 ┌───────────────────────┐               ┌─────────────────────────────┐
 │ the live session      │──/ws/agent-───►│ claude  (interactive, in a │
 │ keystrokes / prompts  │◄──attach──────│   pty the HOST owns)        │
 └───────────────────────┘               │          ▲                  │
                                         │          │ same session     │
  at the computer:                       │          │ same screen      │
  $ npm run attach ──────────────────────┼──────────┘                  │
    (Ctrl-] to detach; it keeps running) └─────────────────────────────┘
```

Sessions created before this — and anything that asks for `kind: "stream"` —
still run the original stream-json child with Allow/Deny on the phone:

```
 ┌───────────────────────┐               ┌─────────────────────────────┐
 │ prompt (text / voice) │──ws /agent───►│ claude  (stream-json, in    │
 │ live activity feed    │◄──events──────│          the project folder)│
 │ Allow / Deny banner   │◄──permission──│   ▲ every tool use          │
 │                       │───answer─────►│   │ approval-mcp.cjs        │
 └───────────────────────┘               │   └ blocks until you answer │
                                         └─────────────────────────────┘
```

## How it works

- Each session is a `claude` process started in a project folder you pick.
  New sessions run the real interactive CLI inside a terminal the host owns, so
  the phone and the computer can be on the same live session at once — see
  [Parity](#parity-one-session-the-phone-and-the-computer-at-the-same-time)
  below. Sessions created before that (and anything asking for
  `kind: "stream"`) speak bidirectional stream-json instead, described here.
  Either way the process stays alive between prompts and is revived with
  `--resume` after a host restart, so conversations keep their context.
- Permissions use Claude Code's `--permission-prompt-tool` hook: a tiny
  bundled MCP sidecar (`server/approval-mcp.cjs`) receives every "may I run
  this?" ask, forwards it to the Belay host over loopback, and the host holds
  it until you tap **Allow**, **Deny**, or one of the scoped **always**
  options — this exact command, this one file, this tool under a folder, or
  every read-only use in the project. Each grant is minted from the exact ask
  on the card and lasts this session only; active grants show as removable
  chips on the session view. No answer within 30 minutes = deny (configurable via
  `BELAY_APPROVAL_TIMEOUT_MS`; `0` waits forever). The sidecar authenticates
  with a per-process key; the loopback route accepts connections from
  127.0.0.1 only.
- Transcripts are appended to `server/agent-logs/<id>.jsonl` (gitignored) so a
  session's history survives host restarts; session metadata lives in
  `server/belay-agent.json`.

## Parity: one session, the phone and the computer at the same time

The goal is that using Belay feels like coding with an agent while the computer
is right in front of you — because it *is* the same session either way.

A session the phone creates is now the real interactive `claude` CLI running in
a terminal **the Belay host owns** (`server/src/agent-pty.ts`). Nobody's shell
owns that terminal, so anybody can join it:

```
  iPhone ──ws /ws/agent-attach──┐
                                ├──► one pty ──► claude (interactive, in the project)
  npm run attach ───────────────┘        ▲
  (at the computer)                      └ scrollback replayed to whoever joins
```

Walk to the computer, run one command, and you are inside the session already
in progress. Nothing restarts, nothing replays a transcript into a new process,
and the phone stays attached at the same time.

```bash
cd server && npm run attach            # lists the sessions you can join
cd server && npm run attach -- <id>    # join one
```

**Ctrl-]** detaches. It leaves the session running and says so — detaching is
walking away from a screen, not ending the work.

### What that buys over `claude --resume`

| | `--resume` (the old handoff) | attach (parity) |
|---|---|---|
| the process | a **new** one, replaying memory | the **same** one, still running |
| when it works | only once the phone's session is stopped | any time |
| the phone | must let go first | stays attached |
| what you see | a fresh screen | the screen as it is right now |

`--resume` still exists and is still right for one thing: reviving a session
whose process died with a host restart. That is the only time `agent-pty.ts`
passes the flag.

### The rules that make sharing safe

- **Scrollback.** Every session keeps the last ~256 KB of its own output, trimmed
  on a line boundary (a cut inside an escape sequence paints garbage). A client
  that joins mid-session is replayed that buffer before any live data, so it
  sees the current screen rather than an empty rectangle.
- **Size is the *minimum* of every attached client** — tmux's rule. A pty has
  one size, so with a phone at 60x30 and a laptop at 200x50 somebody has to be
  wrong. Sizing to the largest client means the smaller one silently loses the
  right-hand columns and the bottom rows, and loses them invisibly, because the
  program drawing the screen believes it has room it does not have. Sizing to
  the smallest leaves unused space around the session on the big screen, which
  is obvious, harmless, and correct for everyone. Recomputed on attach, detach,
  and any client's resize; with nobody attached the last size is kept.
- **Backpressure is per client and it drops.** A saturated client's output is
  discarded (and it is told, rather than letting a hole pass for silence) — the
  shared pty is never paused, because one phone on a bad connection must not
  stall the session for the laptop next to it.
- **The session outlives every client.** Detaching never kills it. The idle
  reaper measures *silence*, not loneliness: thirty minutes with no bytes in
  either direction, regardless of whether anyone is watching. A session with
  nobody attached is not abandoned, it is unattended — which is the entire
  premise of starting work from the phone and putting the phone away.
- **A host restart revives it.** `server/belay-agent.json` keeps the kind, the
  folder and the Claude session id (recovered from Claude Code's own transcript
  on disk), and the first attach after a restart starts the session again with
  `--resume`. Lazily, because a host that just booted should not spawn one
  Claude per session nobody has asked for yet.

### Session kinds

Sessions now carry an explicit `kind`, published in every REST payload the app
reads (`GET /agent/sessions`, `GET /agent/sessions/:id`) alongside `attached`
and `live` counts:

- **`pty`** — the default for anything created from the phone today. Attachable,
  shareable, its own terminal. Permission asks are Claude Code's own dialog, in
  the session, answerable from either side.
- **`stream`** — the original stream-json child with the phone-only approval
  flow (`--permission-prompt-tool` + `approval-mcp.cjs`). Sessions that already
  existed keep this shape, and `POST /agent/sessions` still accepts
  `{"kind":"stream"}` explicitly. Nothing about that path changed.

`POST /agent/sessions/:id/prompt` works for both: on a `pty` session it types
the line and presses Enter, which is what "send a prompt" means when the session
has a terminal.

### The attach socket, for client authors

`/ws/agent-attach?id=<session>&cols=<n>&rows=<n>`, authenticated exactly like
`/ws/terminal` (a `/ws-ticket` ticket, or the legacy token). The message
vocabulary is `/ws/terminal`'s, so a client can reuse its terminal renderer:

| direction | message |
|---|---|
| host → client | `{type:'ready', mode:'pty', cols, rows, attached, session:{id,title,cwd}}` |
| host → client | `{type:'data', data}` — scrollback first, then live output |
| host → client | `{type:'resize', cols, rows}` — the effective (minimum) size |
| host → client | `{type:'exit'}` / `{type:'error', error}` |
| client → host | `{type:'data', data}` — keystrokes |
| client → host | `{type:'resize', cols, rows}` — this client's window |

`ready` always arrives before the first `data`. The host→client `resize` is the
addition over `/ws/terminal`: with several clients the size is negotiated, so a
client has to be told what it actually got.

### On the phone

The Agent tab branches on `kind` before it draws anything. A `pty` session opens
the Terminal tab's own machinery pointed at `/ws/agent-attach` — the same ANSI
parser, the same line list, the same key bar that supplies the Esc / Tab / Ctrl
/ arrows a phone keyboard does not have — so there is one terminal renderer in
the app, not two. A `stream` session opens the structured feed and approval
cards exactly as before. Until the host has said which it is, neither is drawn:
a feed rendered over a live terminal looks like a session that lost its history.

What the phone does with the parts of the protocol that are specific to sharing:

- **The negotiated size is authoritative.** The phone measures itself, asks for
  that, and then lays the screen out to whatever the host granted — the minimum
  across every attached client. When that is smaller *and* somebody else is on
  the session, the header says so quietly: `sized to the desk terminal · 40×12`.
  Alone on the pty it stays silent, because then the smaller size is the host's
  own floor and blaming a colleague would be an invention.
- **"Someone else is looking at this"** is worded differently in the two places
  it appears, on purpose. In the session view this phone is one of the attached
  clients, so it reports the others (`1 other attached`). In the session list
  the view is closed and this phone is attached to nothing, so every client the
  host reports is somebody else and the row shows the plain count
  (`1 attached`). Subtracting one there would hide the single desk terminal
  that is the entire point of saying it.
- **The count is polled, not pushed.** `ready` carries `attached` once and the
  socket has no message for somebody joining later, so the open session view
  asks `GET /agent/sessions/:id` every few seconds while it is live. Without
  that the header would go stale the moment anyone attached.
- **A dropped socket re-attaches on a backoff** and the host's scrollback replay
  restores the screen, so the phone never sits on a dead one. An *exit* and a
  *refusal* do not retry: there is nothing to replay after an exit, and
  re-attaching would silently start a second `claude`; a refusal would fail the
  same way forever. Both get a visible Reattach instead.

Sessions in the **On this PC** list are untouched by all of this. They are
`claude` processes someone started by typing it themselves, they have no
Belay-owned pty, and the phone offers no Attach on them — only watch, answer,
and take over once the terminal is quiet.

One honest limitation of drawing a TUI this way: the phone's renderer is a
scrollback of lines, not a fixed screen grid with alternate-screen support, and
`terminal-ansi.ts` explicitly no-ops the scroll-region escapes (`DECSTBM`).
Claude Code scrolls *inside* a region, so its absolute cursor addressing lands
one row off on the phone and can scribble over text that had already settled.
This needs no resize to happen — plain scrolling is enough — so fixing the
width negotiation would not fix it and must not be mistaken for having done so.
The live region is always correct, and a full repaint — the key bar's
`clear`, which resets the phone's copy and sends Ctrl-L — restores the rest, which is why this is a rough edge rather than a defect: what
you are reading right now is right; what scrolled past may need one keystroke.
The real fix is a screen-grid renderer with scroll-region support.

### How the command at the computer authenticates

`npm run attach` runs on the host machine, over loopback, and authenticates
with a per-install secret in `~/.belay/attach-secret` (0600, minted at boot) —
the same pattern as the hook secret and the approval sidecar, but its own file,
because the capabilities differ in kind: the hook secret buys an attacker fake
prompts on a phone, this one buys them a keyboard. The secret never travels in
a URL. The CLI presents it in a header on a loopback POST to
`/agent/attach/ticket`, gets back an ordinary single-use WebSocket ticket, and
spends that on the upgrade. That ticket authenticates as a "local console"
handle which **only** `/ws/agent-attach` accepts — it cannot reach the screen,
the shell, or the cursor channel.

### What this does *not* cover, honestly

**A session you start yourself by typing `claude` in your own terminal is still
yours alone.** Belay cannot attach to it, and no amount of work on this side
will change that: that pty belongs to your shell, not to the host, and there is
no supported way for another process to join it. What Belay can do for those
sessions it already does — read the transcript live (`/ws/transcript`), answer
their permission prompts on your phone through the Claude Code hooks, and offer
a `--resume` takeover once the terminal has gone quiet. All of that is below.

Two smaller gaps worth naming:

- The Claude session id used for a post-restart `--resume` is recovered by
  matching Claude Code's transcript files on disk against the session's folder.
  If transcript saving is off, the session still works perfectly — it just
  cannot be revived after a host restart, which is a better failure than
  guessing an id and resuming the wrong conversation.
- `node-pty` is required for a `pty` session; there is no piped fallback, because
  a full-screen TUI cannot run down a pipe. On macOS the usual failure is
  node-pty's `spawn-helper` missing its execute bit, and the error says so.

## Setup

1. Install Claude Code on the PC and make sure `claude` is on PATH.
2. Restart the host. The boot banner shows `Agent: claude CLI found` when it
   is ready.

Voice needs nothing on the computer. Hold-to-talk recognises speech on the
phone through Apple's Speech framework, so there is no model to download and
the audio never leaves the device — it only asks for the microphone and speech
recognition permissions the first time you press it.

## Using it

- **New session** → pick a recent project or type a path (`~` works) → tell
  Claude what to do. The feed shows its narration, each tool call as a one-line
  `▸ Tool detail` entry, and a `✓ done · 12s · $0.08` line per turn.
- **Voice**: hold the mic, talk, release. The transcript lands in the input
  box so you can check it before sending — speech-to-text runs on the phone
  itself, not on your PC or in anyone's cloud.
- **Stop** kills the process mid-turn (the conversation survives; the next
  prompt resumes it). **Remove** on the session list deletes the session entry.
- The **Terminal** tab has `claude` / `claude -c` quick-launch keys for the
  raw interactive CLI when you want it.
- **Getting there**: the desktop's control dock has an **Agent** key (second
  row, first key) that carries the waiting-for-you count; the tool drawer
  still lists it too. On the computers list, a connected computer shows a
  one-line readout under its name — `2 RUNNING · 1 WAITING · 1 LIVE` — that
  opens its Agent tab directly. The line is absent when nothing is happening.

## Watching and taking over terminal sessions

Claude Code keeps every session on disk (`~/.claude/projects/<project>/<id>.jsonl`),
including ones started from a terminal, and it appends to that file as the
session runs. Belay reads those files live, so a session you kicked off at
the desk is readable on the phone without `--resume` and without stopping it.

**On the phone**, the Agent tab's **"On this PC"** section lists them, grouped
by project, first prompt as the preview. A session written to within the last
90 seconds is marked `● LIVE`; the others show how long ago they last wrote.
The list is pushed over the same `/ws/attention` channel as the approval
badge, so a new terminal session appears within seconds of its first write.

Tap a session to open it. What you get depends on whether a terminal is still
driving it:

- **Watching** — while it is live, the phone streams the transcript read-only
  over `/ws/transcript` (the last 100 events, then every new one as it lands
  on disk). The footer says *Being driven from the computer — watching* and
  there is no button: two hands on one session is exactly what this view
  exists to prevent. The `● LIVE` mark in the header flips to
  `quiet · 4m ago` on its own once the terminal stops writing.
- **Taking over** — once the session is quiet, a **Take over from phone**
  button appears. That is the old resume flow: Belay relaunches the session
  with `--resume`, Claude keeps its full memory of the conversation, the
  phone-approval flow attaches from the first action, and the tail of the old
  transcript is replayed into the feed with a `resumed session` line marking
  the join point. If the terminal is in fact still open (just idle), close it
  there first — the 90-second rule reads the file, not the terminal.

The watch is read-only in the strict sense: the phone sends nothing on that
socket, and the host serves transcripts only for sessions inside its allowed
roots (`GET /agent/discovered/:id/transcript?after=<offset>` is the same read
as a one-shot REST call).

**At the PC**, `cd server && npm run sessions` prints the same list in the
terminal with ready-to-paste `cd <project> && claude --resume <id>` commands.
The host banner also prints which `claude` binary it found (PATH first, then
`~/.local/bin`, `~/.claude/local`, Homebrew, and the Windows npm / installer
locations) and whether it is watching `~/.claude/projects` with `fs.watch` or
polling it every 5 seconds.

## Approving terminal sessions from your phone

Watching is read-only; the usual reason a live terminal session needs you is
a permission prompt. With Belay's Claude Code hooks installed, that prompt
goes to the phone instead — no resume, no takeover, the terminal session
keeps running as it was:

```
cd server && npm run hooks:install     # once, on the PC
```

That merges four hook entries into `~/.claude/settings.json` (after backing
it up, without touching any other hooks; `npm run hooks:uninstall` removes
exactly those, `npm run hooks:status` shows what is there). The host banner
prints `Hooks : installed …` when it is set up. From then on, in any
terminal `claude`:

- **A permission ask** appears at the top of the Agent tab under **Needs
  you**, tagged `TERMINAL` with the project name and folder, on the same
  card Belay's own sessions use — the diff, the command, the risk band, and
  **Allow / Deny / Always allow…** (scoped exactly as Claude Code itself
  suggested, for this session only). Tap the header to read the live
  transcript first. The badge on the Agent dock key and the fleet line on
  the devices screen count it, and the push webhook is pinged like any other
  approval.
- **The terminal shows** *Belay: waiting for your phone* while the phone
  decides. If nobody answers within the wait (`BELAY_HOOK_WAIT_MS`, default
  two minutes), or the phone disconnects, the terminal's own dialog appears
  as if Belay were not there. The countdown on the card says *back to the
  terminal in* — it is not a denial.
- **No phone connected = no wait.** The host only holds a prompt while a
  phone is actually on the attention socket; otherwise the terminal prompt
  appears at once. Sessions Belay spawned itself keep using the MCP sidecar
  and are never asked twice.
- **Finished turns and prompts you missed** show under **From the terminal**
  — a `done` notice with the last reply, or `prompt waiting at the terminal`
  when the terminal's dialog sat unanswered for six seconds (no phone was
  connected, or the phone's wait ran out and the prompt went back there).
  Tap to open the transcript, × to dismiss.

The hook script (`server/hooks/belay-hook.mjs`) talks to the host over
loopback only, authenticated with a per-install secret in
`~/.belay/hook-secret` (never the pairing token), and answers "no decision"
on every failure — nothing is ever allowed without a tap. The verified hook
contract and the design constraints it forces are in
[AGENT-HOOKS.md](./AGENT-HOOKS.md).

## Push notifications when the phone is asleep

The premise of this tab — *your computer works, and pings you when it needs a
decision* — breaks the moment the phone goes in a pocket: iOS suspends the
app, the 3-second poll stops, and an approval sits unanswered until the window
runs out. The app cannot fix that from its side (see the note in
`app/src/agent/attention-store.ts`: a local notification must be scheduled in
advance for a known time, and an approval that has not happened yet has no
time). The host, though, is always awake and knows the instant Claude asks.
So the host does the pinging.

When an approval is raised (and when a session errors, and optionally when a
turn finishes) the host POSTs to a webhook you configure. Nothing is compiled
in and no third party is involved unless you point it at one.

### Setup with ntfy (the first-class path)

[ntfy](https://ntfy.sh) is a pub-sub-over-HTTP service with a free iOS app,
and it can be self-hosted so the ping never leaves your own infrastructure.

1. Install the **ntfy** app on the iPhone and subscribe to a topic. Treat the
   topic name like a password — on the public ntfy.sh server, anyone who
   guesses it can read your notifications. `belay-<something long and random>`
   is the minimum; a self-hosted or access-controlled server is better.
2. Start the host with the topic URL:

   ```bash
   BELAY_NOTIFY_URL=https://ntfy.sh/belay-x7f3kq9v2m npm start
   ```

3. The boot banner confirms it:
   `Notify    : https://ntfy.sh/belay-x7f3kq9v2m (ntfy, approval+error, metadata only)`

A lock-screen notification then reads:

> **MacBook Air: Claude needs a decision**
> "belay" wants to run Bash. 30 min to answer, then it is denied.

— which computer, which session, what is being asked, how long is left.
Expired asks ("nobody answered — Bash was denied after 30 min. Send a prompt
to resume."), stopped sessions, and (opted in) finished turns read similarly.
Tapping the notification opens `belay://agent?host=<hostId>&session=<id>` via
ntfy's Click header — see the deep-link note below.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BELAY_NOTIFY_URL` | *(unset — off)* | Where to POST. An ntfy topic URL, or any http(s) endpoint |
| `BELAY_NOTIFY_FORMAT` | `ntfy` | `ntfy` (text body + `Title`/`Priority`/`Click` headers) or `json` (structured payload) |
| `BELAY_NOTIFY_EVENTS` | `approval,error` | Comma list of `approval`, `done`, `error`. Expired approvals count as `approval`; `done` (a ping per finished turn) is opt-in because it fires on every turn |
| `BELAY_NOTIFY_DETAIL` | *(off)* | `on` to include the one-line tool detail (the command, the file path) in the notification |
| `BELAY_NOTIFY_TOKEN` | *(unset)* | Sent as `Authorization: Bearer …` — ntfy access tokens, or your own endpoint's auth. Never logged |

A malformed URL, format or event list turns notifications **off with the
reason in the banner** rather than guessing — a typo that silently meant "no
notifications" would recreate the exact bug this exists to fix.

The `json` format posts one object per event with `event`, `host`, `hostId`,
`session {id,title}`, `tool`, `expiresAt`, a prebuilt `title`/`message`/`link`,
and duplicate `text`/`content` fields — so a Slack incoming webhook or a
Discord webhook URL works with no glue at all, and Home Assistant or your own
relay gets the structured fields.

### What is deliberately *not* in a notification

By default the payload is metadata only: computer label, session title, tool
name, time remaining. The tool's detail line — a shell command, a file path —
is excluded unless `BELAY_NOTIFY_DETAIL=on`, because command lines routinely
carry secrets (`curl -H "Authorization: …"`) and the zero-setup target most
people will try first is the public ntfy.sh server, where the topic name is
the only lock on the door. "MacBook Air: Claude wants to run Bash, 30 min
left" is enough to know whether to pull the phone out; the full ask is one tap
away in the app, over your own authenticated connection. Turn detail on when
the endpoint is your own. Session error pings likewise omit stderr, which
quotes paths and commands.

### Failure cannot touch a session

The webhook fires *after* the approval is already raised and waiting, is never
awaited by any session code path, gives up after 5 seconds, and swallows every
error. A dead DNS name, a hanging server, a 500 — the approval flow cannot
tell the difference. A failing webhook logs one line (with the URL reduced to
its origin — the topic path works like a capability) and stays quiet until it
recovers.

### The deep link, honestly

The host half is done: every notification carries
`belay://agent?host=<hostId>&session=<sessionId>` (ntfy `Click` header /
`link` field), and `belay` is the app's registered URL scheme (the
pre-rename `tether` scheme is still registered too, so notifications sent
before the rename keep opening the app). The
app half still needs a linking handler that (1) parses that URL, (2) selects
the saved computer whose stable `hostId` matches — never matching on address,
which changes — and (3) opens the Agent tab with that session id. Until that
lands, tapping the notification opens the app at its last screen, which is
already most of the value.

### Roads not taken, for the record

- **Live Activities** would be the best UX by far: a persistent lock-screen
  card with the session status and an approval countdown, updateable from the
  host via ActivityKit push. But it requires a native widget extension target
  (out of Expo Go entirely, into a dev-client build with custom native code)
  plus APNs p8 keys and token management on the host. Right answer eventually;
  wrong first step for a self-hosted product still running in Expo Go.
- **An Expo push relay** (`expo-notifications` remote push) is real push with
  modest app-side work — but every "Claude needs you" would transit Expo's
  servers and Apple's, tied to an Expo account. It contradicts the product's
  no-third-party privacy story, so if it comes at all it comes as an opt-in
  alongside the webhook, not instead of it.
- **BGAppRefresh / background fetch** wakes the app at iOS's discretion,
  rarely better than every 15 minutes and freely skipped on battery grounds.
  Against a 30-minute approval window that is a coin flip, and a notification
  system that usually fires is worse than one that visibly needs setup.
- **Local notifications** were investigated and ruled out before this:
  they must be scheduled from foreground JS for a known future time, and an
  approval that has not happened yet has neither. The reasoning is recorded in
  `app/src/agent/attention-store.ts`.

## Threat-model notes

- The agent endpoints sit behind the same bearer-token auth as everything
  else; keep the host off the public internet (Tailscale only), as ever.
- Approvals fail closed: sidecar timeout, host restart, killed session, or an
  unreachable phone all resolve to deny.
- "Always" allowances are scoped grants (an exact command, one file, a folder,
  or project-wide reads — never a whole tool), per-session and in-memory only —
  a restarted session asks again from scratch.
- A session runs with your user account's permissions. Deny anything you don't
  recognize; `rm`, `git push --force`, and friends deserve a hard look before
  Allow.
- Attaching to a session is a live keyboard on the machine, so it is gated
  twice over: the phone needs a pairing token like every other route, and the
  command at the computer needs a 0600 secret in `~/.belay/attach-secret` and a
  loopback connection. The ticket that secret buys is single-use, expires in
  thirty seconds, and is refused on every WebSocket route except
  `/ws/agent-attach`.
- A `pty` session answers its own permission prompts in Claude Code's dialog,
  where either side can answer them — the phone's Allow/Deny cards belong to
  `stream` sessions and to terminal sessions using the hooks. One ask never
  exists in two places at once: the host marks the pty session's environment so
  the hook stands aside.
