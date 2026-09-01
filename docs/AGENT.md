# The Agent tab

Drive Claude Code sessions on your PC from your phone — from anywhere, over
Tailscale — with every action gated on an Allow/Deny tap.

```
  iPhone (Agent tab)                       PC (Belay host)
 ┌───────────────────────┐               ┌─────────────────────────────┐
 │ prompt (text / voice) │──ws /agent───►│ claude  (stream-json, in    │
 │ live activity feed    │◄──events──────│          the project folder)│
 │ Allow / Deny banner   │◄──permission──│   ▲ every tool use          │
 │                       │───answer─────►│   │ approval-mcp.cjs        │
 └───────────────────────┘               │   └ blocks until you answer │
                                         └─────────────────────────────┘
```

## How it works

- Each session is a `claude` process started in a project folder you pick,
  speaking bidirectional stream-json. The process stays alive between prompts
  and is revived with `--resume` after restarts, so conversations keep their
  context.
- Permissions use Claude Code's `--permission-prompt-tool` hook: a tiny
  bundled MCP sidecar (`server/approval-mcp.cjs`) receives every "may I run
  this?" ask, forwards it to the Belay host over loopback, and the host holds
  it until you tap **Allow**, **Deny**, or **Always <tool>** (always = this
  session only). No answer within 30 minutes = deny (configurable via
  `BELAY_APPROVAL_TIMEOUT_MS`; `0` waits forever). The sidecar authenticates
  with a per-process key; the loopback route accepts connections from
  127.0.0.1 only.
- Transcripts are appended to `server/agent-logs/<id>.jsonl` (gitignored) so a
  session's history survives host restarts; session metadata lives in
  `server/belay-agent.json`.

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
  box so you can check it before sending — speech-to-text runs on your PC, not
  in anyone's cloud.
- **Stop** kills the process mid-turn (the conversation survives; the next
  prompt resumes it). **Remove** on the session list deletes the session entry.
- The **Terminal** tab has `claude` / `claude -c` quick-launch keys for the
  raw interactive CLI when you want it.

## Resuming past sessions

Claude Code keeps every session on disk (`~/.claude/projects/`), including
ones started from a terminal. Belay surfaces them two ways:

- **On the phone** — the Agent tab's **"On this PC"** section lists them,
  grouped by project, with the first prompt as a preview. Tap one to resume:
  Belay relaunches it with `--resume`, Claude keeps its full memory of the
  conversation, and the phone-approval flow attaches from the first action.
  The old transcript isn't replayed into the feed — a `resumed session` line
  marks the join point. If a session is still open in a terminal on the PC,
  close it there before resuming from the phone.
- **At the PC** — `cd server && npm run sessions` prints the same list in the
  terminal with ready-to-paste `cd <project> && claude --resume <id>` commands.

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
- "Always" allowances are per-tool, per-session, and in-memory only — a
  restarted session asks again from scratch.
- A session runs with your user account's permissions. Deny anything you don't
  recognize; `rm`, `git push --force`, and friends deserve a hard look before
  Allow.
