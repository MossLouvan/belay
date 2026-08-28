# The Agent tab

Drive Claude Code sessions on your PC from your phone — from anywhere, over
Tailscale — with every action gated on an Allow/Deny tap.

```
  iPhone (Agent tab)                       PC (Tether host)
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
  this?" ask, forwards it to the Tether host over loopback, and the host holds
  it until you tap **Allow**, **Deny**, or **Always <tool>** (always = this
  session only). No answer within 5 minutes = deny. The sidecar authenticates
  with a per-process key; the loopback route accepts connections from
  127.0.0.1 only.
- Transcripts are appended to `server/agent-logs/<id>.jsonl` (gitignored) so a
  session's history survives host restarts; session metadata lives in
  `server/tether-agent.json`.

## Setup

1. Install Claude Code on the PC and make sure `claude` is on PATH.
2. (Voice) `cd server && npm run setup:whisper` — downloads a prebuilt
   whisper.cpp binary and the `ggml-base.en` model (~142 MB) into
   `server/whisper/`. Override with `TETHER_WHISPER_CLI` /
   `TETHER_WHISPER_MODEL` if you already have whisper.cpp somewhere.
3. Restart the host. The boot banner shows `Agent: claude CLI found` and
   `Voice: whisper ready` when both are good.

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
ones started from a terminal. Tether surfaces them two ways:

- **On the phone** — the Agent tab's **"On this PC"** section lists them,
  grouped by project, with the first prompt as a preview. Tap one to resume:
  Tether relaunches it with `--resume`, Claude keeps its full memory of the
  conversation, and the phone-approval flow attaches from the first action.
  The old transcript isn't replayed into the feed — a `resumed session` line
  marks the join point. If a session is still open in a terminal on the PC,
  close it there before resuming from the phone.
- **At the PC** — `cd server && npm run sessions` prints the same list in the
  terminal with ready-to-paste `cd <project> && claude --resume <id>` commands.

## Dictation (Screen tab)

Hold the mic next to the text box on the Screen tab: your words are
transcribed on the PC and typed into whatever window has focus, like a remote
dictation key. The last transcript flashes above the input so you can see what
was typed.

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
