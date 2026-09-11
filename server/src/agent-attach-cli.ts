// `npm run attach [-- <id>]` — the command you run AT the computer.
//
// This is the other half of parity. The phone starts a session, it runs while
// you are away, and when you sit down at the machine you do not resume it, you
// do not restart it, and you do not take it away from the phone: you join it.
// Same process, same screen, same keyboard, still attached on the phone.
//
// Everything here runs on the host machine, so it talks to the host over
// loopback and authenticates with ~/.belay/attach-secret (attach-secret.ts
// explains the choice) — a loopback POST with the secret in a header buys a
// single-use WebSocket ticket, and the ticket is what opens the socket.
//
// The terminal is put in raw mode so every keystroke — Ctrl-C, arrows, Esc,
// Tab — goes to the session rather than to this process. That makes restoring
// the mode a correctness requirement, not a nicety: leaving raw mode set on a
// crash hands the user a shell with no echo and no line editing. Every exit
// path goes through restore(), including the ones nobody plans for.

import { WebSocket } from 'ws';

import { ATTACH_SECRET_HEADER, readAttachSecret, attachSecretPath } from './attach-secret.js';
import { productEnv } from './env.js';

/** Ctrl-] — the detach key, the same one telnet and tmux's cousins use. */
const DETACH_KEY = 0x1d;

const DEFAULT_PORT = 8787;

function hostPort(): number {
  const raw = productEnv('PORT');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PORT;
}

function base(): string {
  return `http://127.0.0.1:${hostPort()}`;
}

interface AttachableSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly running: boolean;
  readonly attached: number;
  readonly lastActivity: number;
}

async function loopback(path: string, secret: string, method: 'GET' | 'POST'): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { method, headers: { [ATTACH_SECRET_HEADER]: secret } });
  } catch (e: unknown) {
    throw new Error(
      `could not reach the Belay host on ${base()} — is it running? (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`host refused ${path} (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

/** Set the terminal's window title (OSC 2) — out-of-band, so nothing is overwritten. */
function setTitle(text: string): void {
  if (!process.stdout.isTTY) return;
  // Control characters in a title escape are how a title becomes an injection.
  const safe = text.replace(/[\x00-\x1f\x7f]/g, '');
  try { process.stdout.write(`\x1b]2;${safe}\x07`); } catch { /* not a tty any more */ }
}

function ago(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function printSessions(sessions: readonly AttachableSession[]): void {
  if (sessions.length === 0) {
    process.stdout.write(
      'No live sessions on this computer yet.\n' +
      'Start one from the phone (Agent tab → New session), then run this again.\n',
    );
    return;
  }
  process.stdout.write('Sessions you can attach to:\n\n');
  for (const s of sessions) {
    const state = s.running ? (s.attached > 0 ? `live · ${s.attached} attached` : 'live') : 'stopped';
    process.stdout.write(`  ${s.id}  ${s.title}\n`);
    process.stdout.write(`  ${' '.repeat(s.id.length)}  ${s.cwd}\n`);
    process.stdout.write(`  ${' '.repeat(s.id.length)}  ${state} · ${ago(s.lastActivity)}\n\n`);
  }
  process.stdout.write(`Attach with:  npm run attach -- ${sessions[0].id}\n`);
}

/**
 * Raw mode, with a restore that is safe to call any number of times.
 *
 * Registered against every way this process can end — normal return, Ctrl-\,
 * a thrown error, an unhandled rejection — because the failure mode of not
 * restoring is a terminal the user has to fix by hand.
 */
function rawMode(): { restore: () => void } {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try { if (stdin.isTTY) stdin.setRawMode(wasRaw); } catch { /* not a tty any more */ }
    try { stdin.pause(); } catch { /* already closed */ }
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  process.on('exit', restore);
  process.on('SIGTERM', () => { restore(); process.exit(0); });
  process.on('SIGHUP', () => { restore(); process.exit(0); });
  process.on('uncaughtException', (e) => {
    restore();
    process.stderr.write(`\r\nattach failed: ${e instanceof Error ? e.message : String(e)}\r\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    restore();
    process.stderr.write(`\r\nattach failed: ${e instanceof Error ? e.message : String(e)}\r\n`);
    process.exit(1);
  });
  return { restore };
}

function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

async function attach(id: string, secret: string): Promise<number> {
  const minted = await loopback('/agent/attach/ticket', secret, 'POST') as { ticket?: string };
  if (!minted?.ticket) throw new Error('the host did not issue an attach ticket');

  const size = termSize();
  const url = `ws://127.0.0.1:${hostPort()}/ws/agent-attach`
    + `?id=${encodeURIComponent(id)}&cols=${size.cols}&rows=${size.rows}`
    + `&ticket=${encodeURIComponent(minted.ticket)}`;

  return await new Promise<number>((resolve) => {
    // No Origin header on purpose: this is a native client on the loopback
    // interface, and host-guard.ts treats an absent origin as exactly that.
    const ws = new WebSocket(url);
    const { restore } = rawMode();
    let finished = false;

    const finish = (code: number, message: string): void => {
      if (finished) return;
      finished = true;
      process.stdin.removeListener('data', onKeys);
      process.removeListener('SIGWINCH', onWinch);
      restore();
      try { ws.close(); } catch { /* already closing */ }
      process.stdout.write(message);
      resolve(code);
    };

    const onKeys = (chunk: Buffer): void => {
      // The detach key is consumed here and never forwarded: leaving is this
      // client's business, and the session must not see a stray 0x1d.
      if (chunk.includes(DETACH_KEY)) {
        finish(0,
          `\r\n\x1b[2m[belay] detached. The session is still running — nothing was stopped.\r\n`
          + `        Re-attach here with:  npm run attach -- ${id}\r\n`
          + `        It is also still live on the phone.\x1b[0m\r\n`);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data: chunk.toString('utf8') }));
      }
    };

    const onWinch = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const next = termSize();
      ws.send(JSON.stringify({ type: 'resize', cols: next.cols, rows: next.rows }));
    };

    ws.on('open', () => {
      process.stdin.on('data', onKeys);
      process.on('SIGWINCH', onWinch);
    });

    ws.on('message', (raw) => {
      let msg: { type?: string; data?: string; error?: string; attached?: number; cols?: number; rows?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'data' && typeof msg.data === 'string') {
        process.stdout.write(msg.data);
      } else if (msg.type === 'ready') {
        const others = Math.max(0, (msg.attached ?? 1) - 1);
        process.stdout.write(
          `\x1b[2m[belay] attached${others > 0 ? ` · ${others} other client${others === 1 ? '' : 's'} on this session` : ''}`
          + ` · Ctrl-] to detach\x1b[0m\r\n`,
        );
      } else if (msg.type === 'resize') {
        // Informational: the pty is sized to the smallest attached client, so
        // this says what everyone actually got. It goes in the window title,
        // not on the screen — `claude` is a full-screen TUI on the alternate
        // buffer, and a line of our text written into it overwrites whatever
        // the CLI had drawn on that row until its next repaint. The title is
        // the one place a terminal will show a word of ours without one of
        // Claude's going missing for it.
        const mine = termSize();
        if (msg.cols && msg.rows && (msg.cols < mine.cols || msg.rows < mine.rows)) {
          setTitle(`belay · ${msg.cols}x${msg.rows} (smallest attached client) · Ctrl-] detaches`);
        }
      } else if (msg.type === 'exit') {
        finish(0, '\r\n\x1b[2m[belay] the session ended.\x1b[0m\r\n');
      } else if (msg.type === 'error') {
        finish(1, `\r\n\x1b[31m[belay] ${msg.error || 'attach failed'}\x1b[0m\r\n`);
      }
    });

    ws.on('error', (e) => finish(1, `\r\n\x1b[31m[belay] connection failed: ${e.message}\x1b[0m\r\n`));
    ws.on('close', () => finish(0, '\r\n\x1b[2m[belay] disconnected from the host.\x1b[0m\r\n'));
  });
}

async function main(): Promise<void> {
  const secret = readAttachSecret();
  if (!secret) {
    process.stderr.write(
      `No attach secret at ${attachSecretPath()}.\n` +
      'The Belay host mints it at boot — start the host on this computer first (npm start).\n',
    );
    process.exit(1);
  }

  const id = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!id) {
    const listed = await loopback('/agent/attach/sessions', secret, 'GET') as { sessions?: AttachableSession[] };
    printSessions(listed?.sessions ?? []);
    return;
  }
  process.exit(await attach(id, secret));
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
