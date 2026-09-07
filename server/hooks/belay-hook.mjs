#!/usr/bin/env node
// Belay's Claude Code hook. Claude Code runs this with a JSON event on stdin
// (see docs/AGENT-HOOKS.md for the contract); this script forwards it to the
// Belay host on loopback and, for a PermissionRequest, waits for the phone's
// decision and prints it on stdout in the shape Claude Code expects.
//
// The whole design is "do no harm when Belay is not there":
//   - host down, secret missing, network error, bad response → print nothing,
//     exit 0. Claude Code then shows its ordinary terminal prompt.
//   - the host itself says "no decision" ({}) when no phone is connected, so
//     the terminal prompt appears at once instead of after a wait.
//   - nothing here ever prints an allow on its own; a decision only ever
//     comes from the host, which only ever gets one from the phone.
//
// No dependencies, no build step: `node belay-hook.mjs --port 8787` is the
// whole command, installed into ~/.claude/settings.json by `npm run
// hooks:install`. Exit code 2 is never used — for PermissionRequest it is not
// honoured anyway, and for the other events it would block Claude Code.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 8787;
const SECRET_HEADER = 'x-belay-hook-secret';
const REASON_HEADER = 'x-belay-hook';
// How long the script itself will wait for the host, for a PermissionRequest.
// The host holds the request for its own (shorter) wait and answers {} when it
// gives up; this is only the backstop if the host never answers at all. It
// stays under the `timeout` the installer writes so the host, not Claude
// Code's timeout, is what ends the wait.
const PERMISSION_WAIT_MS = 590_000;
const OTHER_WAIT_MS = 3_000;
const STDIN_CAP = 2 * 1024 * 1024;

/** `--port 8787` or `--port=8787`; anything else is the default. */
function portFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a === '--port' ? argv[i + 1] : a.startsWith('--port=') ? a.slice(7) : undefined;
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

function readSecret() {
  try {
    const raw = readFileSync(join(homedir(), '.belay', 'hook-secret'), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= STDIN_CAP) chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** stderr only shows in Claude Code's verbose mode; it never affects the decision. */
const note = (msg) => { try { process.stderr.write(`[belay-hook] ${msg}\n`); } catch { /* nothing to do */ } };

async function main() {
  // A Belay-spawned session answers through its own MCP sidecar; asking the
  // phone twice for one tool call would be worse than not asking at all.
  if (process.env.BELAY_SPAWNED === '1') return;

  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { note('stdin was not JSON'); return; }
  if (typeof payload !== 'object' || payload === null) return;
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!/^[A-Za-z]{1,40}$/.test(event)) return;

  const secret = readSecret();
  if (!secret) { note('no ~/.belay/hook-secret — is the Belay host running?'); return; }

  const isPermission = event === 'PermissionRequest';
  const port = portFromArgs(process.argv.slice(2));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), isPermission ? PERMISSION_WAIT_MS : OTHER_WAIT_MS);
  timer.unref?.();

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/hooks/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
      body: raw,
      signal: ctl.signal,
    });
  } catch (e) {
    note(`host unreachable on 127.0.0.1:${port} (${e instanceof Error ? e.message : String(e)})`);
    return;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) { note(`host answered ${res.status}`); return; }
  if (!isPermission) return;

  let out;
  try { out = await res.json(); } catch { note('host answer was not JSON'); return; }
  const reason = res.headers.get(REASON_HEADER);
  if (reason) note(reason);
  // Only a decision the host actually made is printed; {} and anything odd
  // stays silent so Claude Code falls through to its own prompt.
  if (typeof out !== 'object' || out === null) return;
  const hs = out.hookSpecificOutput;
  if (typeof hs !== 'object' || hs === null || hs.hookEventName !== 'PermissionRequest') return;
  const behavior = hs.decision && hs.decision.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: hs }));
}

main().then(() => process.exit(0), (e) => { note(e instanceof Error ? e.message : String(e)); process.exit(0); });
