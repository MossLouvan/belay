# Claude Code hooks — the verified contract Belay builds on

Belay lets a `claude` session started in an ordinary terminal have its
permission prompts answered from the phone. It does this with Claude Code's
**hooks** — no tty typing, no spawning, no `--resume`. This file records what
the hook API actually is, checked against the official docs before a line of
the integration was written, and the tradeoffs that follow from it.

Source of truth: <https://code.claude.com/docs/en/hooks> (the older
<https://docs.claude.com/en/docs/claude-code/hooks> 301-redirects there).
Verified against the docs and a local `claude` 2.1.263 on 2026-08-31. Section
anchors below are into that page.

## Events Belay uses

| Event | Fires | Belay does |
| :-- | :-- | :-- |
| `PermissionRequest` | when Claude Code is about to show its permission dialog (matcher = tool name) | forwards the ask to the phone and returns its decision |
| `Notification` (matcher `permission_prompt`) | ~6 s after a permission prompt has been waiting with nobody typing | lists a "prompt waiting at the terminal" notice on the phone |
| `Stop` | the main agent finished a turn (not on user interrupt) | lists a "done" notice with `last_assistant_message`, and pings the push webhook |
| `SessionStart` | a session starts / resumes / clears (`source` field) | rescans `~/.claude/projects` so the session shows in "On this PC" at once |

`UserPromptSubmit` was checked (input: `prompt`; can block with exit 2 or
`decision: "block"`) and is **not** installed — Belay has no reason to
intercept what the person at the keyboard types.

## The stdin / stdout contract

Every command hook gets **one JSON object on stdin** and may print **one JSON
object on stdout**. Common input fields (`#common-input-fields`):
`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.

### PermissionRequest (`#permissionrequest`)

Input adds `tool_name`, `tool_input` (no `tool_use_id`) and an optional
`permission_suggestions` array — the same permission-update entries the
dialog's "always allow" options are built from (`addRules` /
`replaceRules` / `removeRules` / `setMode`, each with a `destination`).

Output — the **only** way to decide:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }], "behavior": "allow", "destination": "session" }
      ]
    }
  }
}
```

- `behavior`: `"allow"` or `"deny"`. Deny and ask rules are still evaluated —
  an `allow` never overrides a matching deny rule.
- `updatedInput`, `updatedPermissions` — allow only. `message`, `interrupt` —
  deny only.
- Printing `{}` (or nothing) = **no decision** → Claude Code shows its normal
  terminal dialog. This is Belay's fallback for every failure.
- **Exit code 2 does not deny** on this event: "A hook that exits 2 without a
  `decision` object leaves the permission flow unchanged, and its stderr is
  discarded." Belay's script always exits 0.
- In sessions that cannot show a prompt (headless, background subagents) the
  hook still runs and, with no decision, the call is **denied** — so a hook
  that prints `{}` is safe there too.
- Does not fire for a sandboxed command's network-access prompt (only the
  `permission_prompt` notification does).

### Notification (`#notification`)

Input adds `message`, `title`, `notification_type`. The matcher is the
notification type. `permission_prompt` fires only after the dialog has waited
about six seconds — it is a lagging signal, which is why the decision path is
`PermissionRequest` and this is only a notice.

### Stop (`#stop`)

Input adds `stop_hook_active`, `last_assistant_message`, `background_tasks`,
`session_crons`. Exit 2 / `decision: "block"` would make Claude continue;
Belay never does that (the hook is installed `async`, so it cannot).

### SessionStart (`#sessionstart`)

Input adds `source` (`startup` / `resume` / `clear` / `compact`), `model`,
optional `agent_type`. Output may add context; Belay prints nothing.

## Timeouts (`#timeouts`)

- `timeout` on a hook entry is in **seconds**; the default is 600.
- A `command` hook that reaches its timeout is cancelled and its output
  discarded — "on most events a timed-out hook renders no decision". For
  `PermissionRequest` that means the terminal dialog appears, as if the hook
  had printed `{}`. Nothing is ever auto-allowed.
- `async: true` runs the hook in the background: no output is read, the
  timeout is not enforced, Claude does not wait. Belay installs the three
  side hooks (`Notification`, `Stop`, `SessionStart`) this way.
- `statusMessage` (`#common-fields`) is the spinner text shown while a
  synchronous hook runs. **While a `PermissionRequest` hook runs, the
  terminal dialog is hidden behind that spinner.** This is the constraint
  that shapes the whole design — see below.

## Handler fields Belay writes (`#command-hook-fields`, `#exec-form-and-shell-form`)

`npm run hooks:install` merges these into `~/.claude/settings.json`
(backing the file up first, never touching hooks it did not write):

```json
{
  "hooks": {
    "PermissionRequest": [ { "hooks": [ { "type": "command",
        "command": "/path/to/node", "args": ["/path/to/server/hooks/belay-hook.mjs", "--port", "8787"],
        "timeout": 600, "statusMessage": "Belay: waiting for your phone" } ] } ],
    "Notification": [ { "matcher": "permission_prompt", "hooks": [ { "...same command...", "timeout": 15, "async": true } ] } ],
    "Stop":         [ { "hooks": [ { "...", "timeout": 15, "async": true } ] } ],
    "SessionStart": [ { "hooks": [ { "...", "timeout": 15, "async": true } ] } ]
  }
}
```

The **exec form** (`command` + `args`) spawns the process with no shell, so
paths with spaces need no quoting and nothing is re-parsed. `command` is the
absolute `node` the host runs under (`process.execPath`), so the hook works
even when `node` is not on the login shell's PATH.

## How Belay uses it

```
 terminal claude ──stdin──► belay-hook.mjs ──POST /hooks/PermissionRequest──► host
                                 │           (loopback, x-belay-hook-secret)   │ holds the request
                                 │                                             │ pushes on /ws/attention
                                 │                                             ▼
                                 │                                          phone: Allow / Deny / Always…
                                 │                                             │ POST /agent/hooks/:id/decide
                 ◄──stdout────── ◄────────── {hookSpecificOutput…} ◄───────────┘
```

1. `server/hooks/belay-hook.mjs` (no deps) reads stdin, reads the per-install
   secret from `~/.belay/hook-secret` (0600, written by the host at boot,
   never the pairing token) and POSTs the event to
   `http://127.0.0.1:<port>/hooks/<event>`.
2. The host validates the payload (`hooks-validate.ts`), and for a
   `PermissionRequest`:
   - answers `{}` **immediately** if the session is one Belay spawned
     itself (those use the MCP sidecar) or if **no phone is on
     `/ws/attention`** — because the terminal dialog is hidden while the
     hook runs, holding it with nobody to answer would only delay the person
     at the keyboard;
   - otherwise holds the request (`BELAY_HOOK_WAIT_MS`, default 120 s,
     clamped 5–570 s), publishes it on `/ws/attention`, pings the push
     webhook, and returns the phone's decision when it lands. If the wait
     runs out, or the last phone disconnects, it answers `{}` and the
     terminal dialog appears. The reason travels in an `x-belay-hook`
     header the script echoes to stderr.
3. The script prints the decision object only when `behavior` is
   `allow`/`deny`, and always exits 0. An "Always allow…" choice on the phone
   is returned as `updatedPermissions` with `destination: "session"`, built
   from the `permission_suggestions` Claude Code itself proposed — never
   wider.

The script also bails at once when `BELAY_SPAWNED=1` (set on Belay's own
sessions), so those never double-ask.

### Tradeoffs to know

- **The phone path only works while the app is open and connected.** That is
  deliberate: with the phone gone the host answers "no decision" and the
  terminal works exactly as before. Push notifications still arrive (the
  webhook is pinged before the wait starts), and opening the app connects
  the socket — but if the wait already expired, the prompt is at the
  terminal.
- While the phone is deciding, the terminal shows *Belay: waiting for your
  phone* instead of its dialog. Deciding at the keyboard means waiting for
  the phone's timeout (or closing the app). Keep `BELAY_HOOK_WAIT_MS` short
  if you often work at both.
- Nothing is ever auto-allowed: every failure mode (host down, secret
  missing, bad JSON, timeout, phone left) is "no decision".
