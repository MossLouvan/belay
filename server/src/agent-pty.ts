// Pty-backed agent sessions: the parity path.
//
// The stream-json sessions in agent.ts gave the phone a Claude that nobody at
// the computer could see or touch. The child has pipes, no terminal and no
// window; the only way to reach it from the desk is `claude --resume <id>`,
// which is a *different* process replaying memory, and which only works once
// the phone's session has been stopped. Terminal-started sessions have the
// mirror problem: the tty belongs to the user's shell, so Belay can read the
// transcript and answer hook prompts but can never type.
//
// So Belay owns the terminal. A session here is the real interactive `claude`
// CLI running inside a pty this process created — no stream-json flags, no
// --permission-prompt-tool, the same program you get by typing `claude`. Every
// client (the phone, `npm run attach` at the desk, a second phone) is just
// another subscriber on that one pty: same bytes out, any client's bytes in.
// Walking to the computer joins the session already in progress. Nothing
// restarts, nothing replays, nobody is evicted.
//
// Three rules make that safe, and each has its reason written where it lives:
//   - scrollback  (agent-pty-buffer.ts) — a late attacher sees the screen
//   - min size    (agent-pty-buffer.ts) — nobody's view is silently clipped
//   - lifecycle   (below)               — the session outlives every client

import { existsSync } from 'node:fs';

import { findClaude } from './claude-path.js';
import { PROJECTS_ROOT, scanSessions } from './discover.js';
import {
  appendScrollback, clampDim, DEFAULT_SIZE, minSize, SCROLLBACK_CAP,
} from './agent-pty-buffer.js';
import type { TermSize } from './agent-pty-buffer.js';

// A pty with no TERM breaks anything that uses termcap, and the Claude CLI is
// a full-screen TUI — this is not optional for it the way it is for `ls`.
const TERM_NAME_POSIX = 'xterm-256color';
const TERM_NAME_WINDOWS = 'xterm-color';

/**
 * How long a session with nothing happening in it survives.
 *
 * Matches agent.ts's idle reaper, but the clock is deliberately different:
 * "abandoned" here means no bytes in either direction, not "no client
 * attached". A session with zero attached clients is not abandoned — it is
 * unattended, which is the entire premise of the product (start it from the
 * phone, put the phone away, walk to the computer and join it). Detaching must
 * never be able to kill work, so only silence can.
 */
export const PTY_IDLE_KILL_MS = 30 * 60 * 1000;

/** How often the reaper looks for silent sessions. */
const REAPER_INTERVAL_MS = 60 * 1000;

/** Claude session-id detection: how often to look, and for how long. */
const DETECT_INTERVAL_MS = 15 * 1000;
const DETECT_TRIES = 20;

// ---- the pty a session runs in --------------------------------------------

/** The slice of node-pty this module uses. Injectable so tests need no pty. */
export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export interface SpawnSpec {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** Set only when reviving across a host restart — see buildPtyArgs. */
  readonly claudeSessionId?: string;
}

export type PtySpawner = (spec: SpawnSpec) => Promise<PtyHandle>;

/**
 * The argv for the interactive CLI.
 *
 * Empty in the normal case: this is `claude`, exactly as a human runs it. The
 * only flag that ever appears is `--resume`, and only when the host is reviving
 * a session whose pty died with the previous host process — that is the one
 * moment where replaying memory into a new process is the right thing, because
 * the old process is genuinely gone.
 */
export function buildPtyArgs(claudeSessionId?: string): string[] {
  return claudeSessionId ? ['--resume', claudeSessionId] : [];
}

// node-pty is an optionalDependency; loaded lazily so a host without it still
// boots (the same contract terminal.ts has).
let ptyModule: unknown = null;
let ptyChecked = false;

async function loadPty(): Promise<any> {
  if (ptyChecked) return ptyModule;
  ptyChecked = true;
  try { ptyModule = await import('node-pty'); }
  catch { ptyModule = null; }
  return ptyModule;
}

/**
 * Environment markers Claude Code sets for the processes IT spawns.
 *
 * They are inherited, and a host that was itself started from inside a Claude
 * Code session (running `npm start` from an agent, which is exactly how this
 * was first tested) passes them straight into the pty. The CLI then believes it
 * is a nested child of another session: it prints "Transcript saving is off —
 * inherited CLAUDE_CODE_CHILD_SESSION marker" and writes no transcript at all,
 * which quietly costs this module the one thing it needs from disk — the claude
 * session id that makes `--resume` possible after a host restart.
 *
 * So they are scrubbed. A Belay session is a *top-level* `claude`, identical to
 * the one the user gets by typing the command in a fresh terminal, and that is
 * what it should look like from the inside. Named explicitly rather than wiped
 * by prefix: a user's own `CLAUDE_*` configuration is theirs and is passed
 * through untouched.
 */
export const INHERITED_CLAUDE_MARKERS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]);

/**
 * The environment a session's `claude` runs in. Returns a new object; the
 * caller's env is never mutated.
 */
export function ptyEnv(
  base: Readonly<Record<string, string | undefined>> = process.env as Record<string, string>,
  plat: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (INHERITED_CLAUDE_MARKERS.includes(key)) continue;
    env[key] = value;
  }
  // Read by hooks/belay-hook.mjs. This session has a real terminal that the
  // user can reach from the phone or the desk, so Claude's own permission
  // dialog is the right UI for it — the hook must not also fire the ask at the
  // phone, or one approval would exist in two places at once.
  env.BELAY_SPAWNED = '1';
  env.BELAY_PTY_SESSION = '1';
  if (plat !== 'win32') {
    env.TERM = env.TERM || TERM_NAME_POSIX;
    env.COLORTERM = env.COLORTERM || 'truecolor';
    env.LANG = env.LANG || 'en_US.UTF-8';
  }
  return env;
}

/** The real spawner: the interactive `claude` CLI inside a host-owned pty. */
export const spawnClaudePty: PtySpawner = async (spec) => {
  const pty = await loadPty();
  if (!pty) throw new Error('node-pty is not installed on this host, so a live session cannot be started');
  const cmd = findClaude();
  if (!cmd) throw new Error('claude CLI not found on PATH — install Claude Code on this machine first');
  if (!existsSync(spec.cwd)) throw new Error(`project folder is gone: ${spec.cwd}`);

  const win = process.platform === 'win32';
  const env = ptyEnv();

  const args = buildPtyArgs(spec.claudeSessionId);
  let term: any;
  try {
    term = ptySpawn(pty, cmd, args, spec, win, env);
  } catch (e: unknown) {
    // The terminal tab degrades to a piped shell when node-pty cannot spawn; a
    // full-screen TUI has no such fallback, so the failure has to be legible
    // instead. On macOS it is almost always one thing: node-pty's postinstall
    // did not run, so prebuilds/<platform>/spawn-helper is missing its execute
    // bit and every spawn dies as "posix_spawnp failed".
    const message = e instanceof Error ? e.message : String(e);
    if (/posix_spawnp/i.test(message) && process.platform !== 'win32') {
      throw new Error(
        `${message} — node-pty's spawn helper is not executable. `
        + 'Fix it with: chmod +x server/node_modules/node-pty/prebuilds/*/spawn-helper',
      );
    }
    throw e;
  }
  return wrapPty(term);
};

function ptySpawn(
  pty: any, cmd: string, args: readonly string[], spec: SpawnSpec,
  win: boolean, env: Record<string, string>,
): any {
  return pty.spawn(cmd, [...args], {
    name: win ? TERM_NAME_WINDOWS : TERM_NAME_POSIX,
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    // ConPTY is the Windows pty; node-pty selects it by default on a modern
    // Windows and falls back to winpty on its own, exactly as the terminal tab
    // relies on — so there is nothing to choose here.
    env,
  });
}

function wrapPty(term: any): PtyHandle {
  return {
    write: (d) => { try { term.write(d); } catch { /* pty closed */ } },
    resize: (c, r) => { try { term.resize(c, r); } catch { /* pty closed */ } },
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(() => cb()),
    kill: () => { try { term.kill(); } catch { /* already gone */ } },
  };
}

// ---- clients ---------------------------------------------------------------

/**
 * One attached viewer. The registry never knows what a client is made of — a
 * WebSocket to a phone, a loopback socket to the CLI at the desk — only how to
 * push bytes at it and whether it is keeping up.
 */
export interface AttachClient {
  /** Pty output, live or replayed. */
  onData(data: string): void;
  /** The pty exited; the session is over for everybody. */
  onExit(): void;
  /** The effective (minimum) size changed, so the client can letterbox. */
  onSize?(size: TermSize): void;
  /**
   * False while this client's own buffer is saturated. Output is dropped for
   * it — never buffered without bound, and never by pausing the pty, because
   * one phone on a bad train connection must not stall the session for the
   * laptop sitting next to it.
   */
  accepts?(): boolean;
  /** The size this client wants. */
  readonly size: TermSize;
}

export interface Attachment {
  /** Send keystrokes to the shared pty. */
  write(data: string): void;
  /** This client's window changed; recomputes the effective minimum. */
  resize(cols: number, rows: number): void;
  /** Leave. The session keeps running — that is the whole point. */
  detach(): void;
  /** The effective size right now. */
  size(): TermSize;
  /** How many clients are attached, including this one. */
  attached(): number;
}

interface ClientRec {
  readonly client: AttachClient;
  size: TermSize;
  lagging: boolean;
}

// ---- sessions --------------------------------------------------------------

export interface PtySessionSpec {
  readonly id: string;
  readonly cwd: string;
  readonly title?: string;
  readonly claudeSessionId?: string;
}

export interface PtySessionInfo {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly running: boolean;
  readonly attached: number;
  readonly claudeSessionId?: string;
  readonly size: TermSize;
  readonly scrollbackBytes: number;
  readonly lastActivity: number;
}

interface PtySession {
  readonly id: string;
  cwd: string;
  title: string;
  claudeSessionId?: string;
  handle?: PtyHandle;
  /** In-flight spawn, so two simultaneous attaches cannot start two claudes. */
  starting?: Promise<void>;
  scrollback: string;
  clients: Set<ClientRec>;
  size: TermSize;
  lastActivity: number;
  detectTimer?: NodeJS.Timeout;
}

export interface RegistryOptions {
  readonly spawn?: PtySpawner;
  readonly cap?: number;
  readonly now?: () => number;
  readonly idleKillMs?: number;
  /** Called whenever a session's claude session id is first learned. */
  readonly onClaudeSessionId?: (id: string, claudeSessionId: string) => void;
  /** Best-effort lookup of the claude session id for a project folder. */
  readonly detect?: (cwd: string, since: number) => string | null;
  /** How often to look for it. Tests shorten this; nothing else should. */
  readonly detectIntervalMs?: number;
  /** Set false in tests: no background timers. */
  readonly reap?: boolean;
}

export interface PtyRegistry {
  register(spec: PtySessionSpec): void;
  has(id: string): boolean;
  /** Start the pty if it is not already running. Safe to call repeatedly. */
  ensureRunning(id: string): Promise<void>;
  attach(id: string, client: AttachClient): Promise<Attachment | null>;
  /** Type into the session without attaching — the phone's /prompt route. */
  write(id: string, data: string): boolean;
  info(id: string): PtySessionInfo | null;
  list(): PtySessionInfo[];
  /** Kill the process, keep the metadata so --resume can revive it. */
  stop(id: string): void;
  /** Kill and forget entirely. */
  remove(id: string): void;
  /** Reap sessions that have been silent past the idle window. Exposed for tests. */
  reapIdle(): string[];
  /** Stop the background reaper (tests, shutdown). */
  dispose(): void;
}

/** Belay's own lines inside the session's stream, marked so they read as ours. */
function belayLine(text: string): string {
  return `\r\n\x1b[2m[belay] ${text}\x1b[0m\r\n`;
}

export function createPtyRegistry(options: RegistryOptions = {}): PtyRegistry {
  const spawn = options.spawn ?? spawnClaudePty;
  const cap = options.cap ?? SCROLLBACK_CAP;
  const now = options.now ?? Date.now;
  const idleKillMs = options.idleKillMs ?? PTY_IDLE_KILL_MS;
  const detect = options.detect ?? detectClaudeSessionId;
  const detectIntervalMs = options.detectIntervalMs ?? DETECT_INTERVAL_MS;
  const sessions = new Map<string, PtySession>();

  const touch = (s: PtySession): void => { s.lastActivity = now(); };

  const fanOut = (s: PtySession, data: string): void => {
    for (const rec of s.clients) {
      // Backpressure is per client and it drops, it never pauses the pty: the
      // pty is shared, so pausing it to protect one slow viewer would freeze
      // the session for everyone including the process doing the work.
      const ok = rec.client.accepts ? rec.client.accepts() : true;
      if (!ok) { rec.lagging = true; continue; }
      if (rec.lagging) {
        rec.lagging = false;
        // Say so rather than letting a hole in the stream pass for output. The
        // bytes are gone (they would have been an unbounded buffer otherwise);
        // a redraw is one keystroke away and the scrollback still has them for
        // the next attacher.
        try { rec.client.onData(belayLine('output skipped on this client (slow link) — press Ctrl-L to redraw')); }
        catch { /* going away anyway */ }
      }
      try { rec.client.onData(data); } catch { /* dropped on close */ }
    }
  };

  const applySize = (s: PtySession): void => {
    const next = minSize([...s.clients].map((c) => c.size), s.size);
    if (next.cols === s.size.cols && next.rows === s.size.rows) return;
    s.size = next;
    s.handle?.resize(next.cols, next.rows);
    for (const rec of s.clients) { try { rec.client.onSize?.(next); } catch { /* gone */ } }
  };

  const armDetect = (s: PtySession): void => {
    if (s.claudeSessionId || s.detectTimer) return;
    const since = now();
    let tries = 0;
    s.detectTimer = setInterval(() => {
      tries++;
      let found: string | null = null;
      try { found = detect(s.cwd, since); } catch { found = null; }
      if (found) {
        s.claudeSessionId = found;
        options.onClaudeSessionId?.(s.id, found);
      }
      if (found || tries >= DETECT_TRIES) {
        clearInterval(s.detectTimer!);
        s.detectTimer = undefined;
      }
    }, detectIntervalMs);
    s.detectTimer.unref?.();
  };

  const start = async (s: PtySession): Promise<void> => {
    if (s.handle) return;
    if (s.starting) return s.starting;
    const attempt = (async () => {
      const handle = await spawn({
        cwd: s.cwd, cols: s.size.cols, rows: s.size.rows, claudeSessionId: s.claudeSessionId,
      });
      s.handle = handle;
      touch(s);
      handle.onData((data) => {
        s.scrollback = appendScrollback(s.scrollback, data, cap);
        touch(s);
        fanOut(s, data);
      });
      handle.onExit(() => {
        if (s.handle !== handle) return;
        s.handle = undefined;
        const line = belayLine('the Claude session ended');
        s.scrollback = appendScrollback(s.scrollback, line, cap);
        for (const rec of s.clients) { try { rec.client.onExit(); } catch { /* gone */ } }
        s.clients.clear();
      });
      // A revived session says so in its own stream: the screen a client is
      // about to see is a --resume replay, not the process they left behind.
      if (s.claudeSessionId && s.scrollback) {
        const line = belayLine('session revived on this computer with --resume');
        s.scrollback = appendScrollback(s.scrollback, line, cap);
        fanOut(s, line);
      }
      armDetect(s);
    })();
    s.starting = attempt.finally(() => { s.starting = undefined; });
    return s.starting;
  };

  const reapIdle = (): string[] => {
    const deadline = now() - idleKillMs;
    const reaped: string[] = [];
    for (const s of sessions.values()) {
      if (!s.handle) continue;
      if (s.clients.size > 0) continue;      // someone is watching: not idle
      if (s.lastActivity > deadline) continue;
      s.handle.kill();
      s.handle = undefined;
      reaped.push(s.id);
    }
    return reaped;
  };

  let reaper: NodeJS.Timeout | undefined;
  if (options.reap !== false) {
    reaper = setInterval(() => { reapIdle(); }, REAPER_INTERVAL_MS);
    reaper.unref?.();
  }

  const infoOf = (s: PtySession): PtySessionInfo => ({
    id: s.id, cwd: s.cwd, title: s.title, running: !!s.handle,
    attached: s.clients.size, claudeSessionId: s.claudeSessionId,
    size: s.size, scrollbackBytes: s.scrollback.length, lastActivity: s.lastActivity,
  });

  return {
    register(spec) {
      if (sessions.has(spec.id)) return;
      sessions.set(spec.id, {
        id: spec.id, cwd: spec.cwd, title: spec.title || spec.id,
        claudeSessionId: spec.claudeSessionId,
        scrollback: '', clients: new Set(), size: DEFAULT_SIZE, lastActivity: now(),
      });
    },

    has(id) { return sessions.has(id); },

    async ensureRunning(id) {
      const s = sessions.get(id);
      if (!s) throw new Error('no such session');
      await start(s);
    },

    async attach(id, client) {
      const s = sessions.get(id);
      if (!s) return null;

      const rec: ClientRec = {
        client,
        size: { cols: clampDim(client.size.cols, DEFAULT_SIZE.cols), rows: clampDim(client.size.rows, DEFAULT_SIZE.rows) },
        lagging: false,
      };
      s.clients.add(rec);
      // Size first, then spawn: a session starting for this attacher should be
      // born the right size rather than resized a frame later.
      applySize(s);
      try {
        await start(s);
      } catch (e: unknown) {
        s.clients.delete(rec);
        applySize(s);
        throw e;
      }

      // Replay before live data. A client that joins mid-session must see the
      // screen as it is, not an empty rectangle with the next keystroke's echo
      // in the corner. Anything the pty emits during this call is appended to
      // the same buffer by the data handler above, so ordering holds.
      if (s.scrollback) { try { client.onData(s.scrollback); } catch { /* gone */ } }
      try { client.onSize?.(s.size); } catch { /* gone */ }

      let detached = false;
      return {
        write(data) {
          if (detached) return;
          touch(s);
          s.handle?.write(data);
        },
        resize(cols, rows) {
          if (detached) return;
          rec.size = { cols: clampDim(cols, rec.size.cols), rows: clampDim(rows, rec.size.rows) };
          applySize(s);
        },
        detach() {
          if (detached) return;
          detached = true;
          s.clients.delete(rec);
          // Deliberately no kill. Detaching is walking away from a screen, not
          // ending the work — the session stays exactly as it was, and the
          // idle clock keeps measuring silence, not loneliness.
          applySize(s);
        },
        size() { return s.size; },
        attached() { return s.clients.size; },
      };
    },

    write(id, data) {
      const s = sessions.get(id);
      if (!s || !s.handle) return false;
      touch(s);
      s.handle.write(data);
      return true;
    },

    info(id) {
      const s = sessions.get(id);
      return s ? infoOf(s) : null;
    },

    list() { return [...sessions.values()].map(infoOf); },

    stop(id) {
      const s = sessions.get(id);
      if (!s) return;
      s.handle?.kill();
      s.handle = undefined;
    },

    remove(id) {
      const s = sessions.get(id);
      if (!s) return;
      s.handle?.kill();
      if (s.detectTimer) clearInterval(s.detectTimer);
      for (const rec of s.clients) { try { rec.client.onExit(); } catch { /* gone */ } }
      sessions.delete(id);
    },

    reapIdle,

    dispose() {
      if (reaper) clearInterval(reaper);
      for (const s of sessions.values()) if (s.detectTimer) clearInterval(s.detectTimer);
    },
  };
}

/**
 * Which Claude session id this pty ended up writing to.
 *
 * A stream-json child announces its session id on stdout; the interactive CLI
 * does not tell us anything, so the id has to be recovered from the transcript
 * Claude Code writes to disk — the newest transcript for this exact folder that
 * was touched after we spawned. Best effort by design: without it the session
 * still works perfectly, it just cannot be revived with --resume after a host
 * restart, which is a strictly better failure than guessing at the wrong id and
 * resuming somebody else's conversation.
 */
export function detectClaudeSessionId(cwd: string, since: number): string | null {
  let found: { id: string; mtime: number } | null = null;
  for (const s of scanSessions(PROJECTS_ROOT, new Set())) {
    if (s.cwd !== cwd) continue;
    // A second of slack: the transcript is created around the spawn, and file
    // mtimes and Date.now() do not agree to the millisecond.
    if (s.mtime < since - 1000) continue;
    if (!found || s.mtime > found.mtime) found = { id: s.claudeSessionId, mtime: s.mtime };
  }
  return found ? found.id : null;
}
