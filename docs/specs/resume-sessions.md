# Spec: Resume any Claude Code session from the Deskhandler Agent tab

**Status:** ready to implement · **Author:** spec written 2026-08-23 · **Repo:** `<repo>`

## Goal

When the user comes back to this computer (physically or via the Deskhandler phone
app), they should see **every Claude Code session that exists on this machine**
— not just the ones started from Deskhandler — and be able to resume any of them
with one tap, with Deskhandler's phone-approval flow attached.

Today the Agent tab only lists sessions Deskhandler itself created
(`server/deskhandler-agent.json`). Sessions started from a terminal (`claude` in any
project) are invisible to it, even though Claude Code persists all of them.

## Background you need (read first)

- **How Deskhandler agent sessions work now:** `server/src/agent.ts`. Each Deskhandler
  session wraps a `claude` process in bidirectional stream-json mode
  (`--input-format stream-json --output-format stream-json --verbose -p`),
  spawned in a project cwd. It already supports process revival via
  `--resume <claudeSessionId>` — the resume mechanism exists; this spec is
  mostly about **discovery** plus **attach**.
- **Permission flow (do not break):** every tool use routes through
  `--permission-prompt-tool mcp__deskhandler-approve__request_permission` served by
  `server/approval-mcp.cjs`, which POSTs to the loopback route
  `/agent/approval-request` in `server/src/index.ts` and blocks until the user
  answers on the phone (5-minute fail-closed timeout). Any resumed session must
  get the same treatment — resuming must go through `ensureProcess()` in
  `agent.ts` (or equivalent) so the MCP config and permission tool are always
  attached.
- **Where Claude Code stores sessions on disk:**
  `~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl` — one JSONL
  transcript per session. The directory name is the project cwd with path
  separators/colons flattened to dashes (e.g.
  `C--Users-you-Documents-deskhandler`). **Do not hand-decode the directory name
  to recover the cwd** — the encoding is lossy. Instead read the `cwd` field
  that appears in the JSONL entries themselves (most entries carry `cwd`;
  read from the first parseable line that has one).
- **JSONL entry shapes vary by Claude Code version.** Parse defensively:
  ignore unparseable lines; treat missing fields as absent, never crash. Useful
  fields commonly present: `sessionId`, `cwd`, `timestamp`, `type`
  (`user`/`assistant`), and message content. There may also be
  `sessions-index.json` or summary entries in newer versions — use them if
  present, but the `.jsonl` scan must work without them.
- **App conventions:** `app/src/agent-view.tsx` (session list UI),
  `app/src/api.ts` (typed client), theme in `app/src/theme.ts`, primitives in
  `app/src/ui.tsx`. Server routes in `server/src/index.ts`; all `/agent/*`
  routes require the bearer-token `auth` middleware except the loopback
  approval route.

## Requirements

### R1 — Discovery (server)

New module `server/src/discover.ts`:

- `discoverSessions(): DiscoveredSession[]` scans
  `~/.claude/projects/*/*.jsonl` and returns, per session:
  - `claudeSessionId` (from the filename / `sessionId` field)
  - `cwd` (from JSONL entries; skip the session if no cwd can be recovered or
    the folder no longer exists)
  - `mtime` (file modified time — proxy for "last active")
  - `preview`: the **first user prompt** of the session (first `type:"user"`
    entry's text, trimmed to ~120 chars) — this is what makes sessions
    recognizable in a list
  - `lastText`: last assistant text snippet if cheaply available (optional)
- **Performance:** transcripts can be tens of MB. Never read whole files:
  read the first ~64 KB for `cwd`/preview and rely on `fs.stat` for mtime.
  Cap the scan (most recent ~100 sessions by mtime across all projects).
  Cache results for ~30 s.
- Exclude sessions already attached to a Deskhandler session
  (`claudeSessionId` match against `deskhandler-agent.json` entries).
- Sessions whose transcript is younger than a few seconds may be mid-write by
  a live terminal `claude`; still list them, but see R3 conflict note.

### R2 — API (server)

- `GET /agent/discovered` (auth) → `{ sessions: DiscoveredSession[] }`,
  newest first, grouped client-side.
- `POST /agent/attach` (auth) body
  `{ claudeSessionId, cwd, title? }` → creates a Deskhandler session whose
  `claudeSessionId` is pre-set, so the next prompt spawns
  `claude ... --resume <id>` with the approval MCP attached. Returns the same
  snapshot shape as `POST /agent/sessions`. Implement in `agent.ts` as e.g.
  `attachSession(cwd, claudeSessionId, title?)` reusing `createSession`
  internals (validate cwd exists; default title = preview or folder name).
- Existing routes unchanged.

### R3 — Conflict safety

If the underlying claude session is *currently open* in a terminal, resuming
it concurrently from Deskhandler would fork/contend. Best-effort guard:

- Before attach, check for a running `claude` process whose cwd matches
  (skip this check if not cheaply possible on Windows — then instead surface
  a warning in the UI copy: "If this session is open in a terminal, close it
  there first").
- `--resume` on a session that another process has open must not corrupt
  Deskhandler state: if the spawned process exits immediately with an error, the
  existing `agent.ts` exit handler already surfaces an `error` event — verify
  that path works for a bogus/locked session id (unit-testable by feeding the
  exit handler).

### R4 — Phone UI (app)

In `agent-view.tsx` `SessionList`:

- Below Deskhandler's own sessions, a section **"On this PC"** listing discovered
  sessions: project folder name (bold), preview text (one line, dim),
  relative time. Group by project folder, newest group first.
- Tap → `api.agentAttach(...)` → open the session screen exactly like an
  existing session. The (possibly long) prior transcript will NOT be
  replayed into the feed — show one info line: `resumed session — context
  restored on the PC` so the user knows Claude remembers even though the
  phone feed starts fresh. (Rendering the old transcript is **out of scope**;
  see Non-goals.)
- A refresh control (pull-to-refresh or a small refresh chip).
- Empty state: section hidden when nothing is discovered.
- New typed client calls in `api.ts`: `agentDiscovered()`, `agentAttach()`.

### R5 — "When I get back" surfacing

The Agent tab is the *phone* path. For walking back up to the PC itself:

- Add `npm run sessions` to `server/package.json` running a small script
  (`server/scripts/list-sessions.mjs`) that prints the same discovery list in
  the terminal: project, preview, age, and the exact resume command
  (`cd <cwd> && claude --resume <id>`). Zero new dependencies.

## Non-goals (explicitly out of scope)

- Replaying historical transcripts into the phone feed (heavy parsing of
  version-variable JSONL; a later iteration can add it).
- Resuming sessions from other machines, or cloud sessions.
- Any change to the approval model ("ask everything" stays the default).
- Auto-resuming anything without an explicit user tap.

## Constraints & house rules

- **No live end-to-end testing on this machine.** Do not start the Deskhandler
  server against the real host, do not run the Playwright suite (it drives a
  live host), do not spawn real `claude` sessions to test resume, and never
  inject input. Verify with unit tests + typechecks only; the user live-tests
  themselves. This is a hard rule for this machine.
- Match existing code style: comment voice, small modules, no new server
  dependencies (plain `node:` APIs only), errors as `{ error }` JSON.
- Windows-first (paths with backslashes, `USERPROFILE`), but keep the mac
  path working (`HOME`).
- `~/.claude/projects` contains transcripts of private conversations — the
  discovery endpoint must stay behind the existing bearer auth, and previews
  should be truncated, never full transcripts.

## Verification (what "done" means)

1. `cd server && npm run typecheck` clean; `cd app && npx tsc --noEmit` clean.
2. Unit tests in `server/test/` (runner: `tsx --test`, see
   `test/agent.test.ts` for style) covering at minimum:
   - JSONL preview/cwd extraction from synthetic fixture files (valid,
     truncated, garbage lines, missing cwd)
   - mtime sorting + cap + exclusion of already-attached ids
   - `attachSession` produces a session whose first spawn args would include
     `--resume <id>` (export the arg-builder or session state so this is
     assertable without spawning)
3. `cd app && npm run export:web` builds.
4. Update `docs/AGENT.md` (short section) and the README feature table row.
5. Report anything you could not verify without live testing as such — do not
   claim it works.
