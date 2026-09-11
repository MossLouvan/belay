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
  appendScrollback, clientSize, DEFAULT_SIZE, minSize, SCROLLBACK_CAP,
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

/**
 * Claude session-id detection: how often to look, and for how long.
 *
 * The transcript only appears once the user has actually said something, and a
 * session started from the phone and left alone can sit at an empty prompt for
 * a long time before the first message. Giving up after five minutes meant a
 * session prompted at minute six had no id at all, and a later revive silently
 * opened a blank `claude` under the old title as if nothing were wrong. So the
 * window matches the idle reaper's: a session that has been silent longer than
 * this is not around to be detected anyway.
 */
const DETECT_INTERVAL_MS = 15 * 1000;
const DETECT_TRIES = Math.ceil(PTY_IDLE_KILL_MS / DETECT_INTERVAL_MS);

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
  // Read by hooks/belay-hook.mjs, which returns immediately when it is set.
  // This session has a real terminal the user can reach from the phone or the
  // desk, so Claude's own permission dialog is the right UI for it — the hook
  // must not also fire the ask at the phone, or one approval would exist in
  // two places at once.
  env.BELAY_SPAWNED = '1';
  // Nothing reads this one. It is set anyway, and deliberately: the marker
  // above is shared with stream sessions, so anything inside a pty session
  // that ever needs to know which of the two it is — a shell prompt, a user's
  // own hook, a person running `env` at the desk to work out what he is
  // attached to — has one honest way to tell.
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

/**
 * Whether this session knows which conversation it is.
 *
 *   'idle'    — never started, so there is nothing to identify yet.
 *   'pending' — started, still watching the transcript directory for ours.
 *   'found'   — identified; `--resume` after a host restart will land here.
 *   'unknown' — the watch ran out, or two candidates appeared and neither
 *               could be proved ours. Deliberately recorded as a failure
 *               rather than a guess: reviving into somebody else's
 *               conversation is worse than not reviving at all.
 */
export type DetectState = 'idle' | 'pending' | 'found' | 'unknown';

export interface PtySessionInfo {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly running: boolean;
  readonly attached: number;
  readonly claudeSessionId?: string;
  /** Whether a host restart could bring this conversation back. */
  readonly resumable: boolean;
  readonly detect: DetectState;
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
  detect: DetectState;
  /**
   * Transcript ids that already existed in this folder when this pty was
   * spawned. Anything in here belongs to somebody else — an earlier Belay
   * session in the same project, or a `claude` the user is running in his own
   * terminal — and can never be ours.
   */
  preSpawnIds?: ReadonlySet<string>;
  /**
   * Announce this session's pty as gone, exactly once. Set by start(); called
   * by the pty's own onExit and by stop()/remove(), whichever gets there first.
   */
  finish?: () => void;
}

export interface RegistryOptions {
  readonly spawn?: PtySpawner;
  readonly cap?: number;
  readonly now?: () => number;
  readonly idleKillMs?: number;
  /** Called whenever a session's claude session id is first learned. */
  readonly onClaudeSessionId?: (id: string, claudeSessionId: string) => void;
  /**
   * Best-effort lookup of the claude session id for a project folder.
   * `before` is the set of transcript ids that existed when this pty spawned;
   * a detector must never return one of them.
   */
  readonly detect?: (cwd: string, since: number, before: ReadonlySet<string>) => string | null;
  /**
   * The transcript ids already on disk for a folder, sampled before spawning.
   * `null` means "could not tell" — which is not the same as "none", and is
   * never treated as evidence that a saved conversation has been deleted.
   */
  readonly existingIds?: (cwd: string) => ReadonlySet<string> | null;
  /** How often to look for it. Tests shorten these; nothing else should. */
  readonly detectIntervalMs?: number;
  readonly detectTries?: number;
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
  const existingIds = options.existingIds ?? transcriptIdsFor;
  const detectIntervalMs = options.detectIntervalMs ?? DETECT_INTERVAL_MS;
  const detectTries = options.detectTries ?? DETECT_TRIES;
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
    const before = s.preSpawnIds ?? new Set<string>();
    s.detect = 'pending';
    let tries = 0;
    s.detectTimer = setInterval(() => {
      tries++;
      let found: string | null = null;
      try { found = detect(s.cwd, since, before); } catch { found = null; }
      if (found) {
        s.claudeSessionId = found;
        s.detect = 'found';
        options.onClaudeSessionId?.(s.id, found);
      } else if (tries >= detectTries) {
        // Say so instead of leaving the session looking resumable. Nothing is
        // recorded: a revive from here starts a fresh conversation, and the
        // phone is told that in advance rather than after the fact.
        s.detect = 'unknown';
      }
      if (found || tries >= detectTries) {
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
      // Everything already on disk for this folder belongs to somebody else.
      // Sampled before the spawn, so the transcript this `claude` is about to
      // create is the one thing that is NOT in the set (see detectClaudeSessionId).
      let known: ReadonlySet<string> | null;
      try { known = existingIds(s.cwd); } catch { known = null; }
      const before: ReadonlySet<string> = known ?? new Set<string>();
      s.preSpawnIds = before;

      // A `--resume <id>` whose transcript has been deleted fails every single
      // time, and the id was never cleared, so every later attach retried the
      // same doomed resume forever. Notice it here instead, once.
      if (s.claudeSessionId && known && !known.has(s.claudeSessionId)) {
        s.claudeSessionId = undefined;
        s.detect = 'unknown';
        const gone = belayLine('the saved conversation is gone from ~/.claude — starting a fresh one');
        s.scrollback = appendScrollback(s.scrollback, gone, cap);
        fanOut(s, gone);
      }
      const reviving = !!s.claudeSessionId;

      const handle = await spawn({
        cwd: s.cwd, cols: s.size.cols, rows: s.size.rows, claudeSessionId: s.claudeSessionId,
      });
      s.handle = handle;
      // Unconditionally, not only when it changed. `s.size` can have moved
      // while the spawn was in flight (a second client attaching, or the first
      // one's post-ready resize) and applySize's write went to a handle that
      // did not exist yet — so without this the pty keeps the size it was born
      // with for the rest of its life while the registry reports another.
      handle.resize(s.size.cols, s.size.rows);
      touch(s);
      handle.onData((data) => {
        s.scrollback = appendScrollback(s.scrollback, data, cap);
        touch(s);
        fanOut(s, data);
      });

      // Announcing the exit is a one-shot, and it must survive the handle
      // having already been cleared: stop() clears it before node-pty's own
      // onExit fires, and the old `s.handle !== handle` guard turned that into
      // a session that was dead on the host and live-looking on every client —
      // no exit message, no detach, keystrokes into nothing, and an `attached`
      // count pinned forever.
      let announced = false;
      const finish = (): void => {
        if (announced) return;
        // A newer pty has taken this session over: its predecessor's exit is
        // not ours to announce, and its clients are not ours to drop.
        if (s.handle && s.handle !== handle) return;
        announced = true;
        s.handle = undefined;
        const line = belayLine('the Claude session ended');
        s.scrollback = appendScrollback(s.scrollback, line, cap);
        for (const rec of s.clients) { try { rec.client.onExit(); } catch { /* gone */ } }
        s.clients.clear();
      };
      s.finish = finish;
      handle.onExit(finish);

      // A revived session says so in its own stream: the screen a client is
      // about to see is a --resume replay, not the process they left behind.
      if (reviving && s.scrollback) {
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
    resumable: !!s.claudeSessionId, detect: s.detect,
    size: s.size, scrollbackBytes: s.scrollback.length, lastActivity: s.lastActivity,
  });

  return {
    register(spec) {
      if (sessions.has(spec.id)) return;
      sessions.set(spec.id, {
        id: spec.id, cwd: spec.cwd, title: spec.title || spec.id,
        claudeSessionId: spec.claudeSessionId,
        scrollback: '', clients: new Set(), size: DEFAULT_SIZE, lastActivity: now(),
        detect: 'idle',
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
        size: clientSize(client.size, DEFAULT_SIZE),
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
          rec.size = clientSize({ cols, rows }, rec.size);
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
      const handle = s.handle;
      // Cleared before the kill so the pty's own onExit, whenever it lands,
      // sees a session with no owner and announces rather than bails.
      s.handle = undefined;
      handle?.kill();
      // node-pty's onExit is asynchronous, so waiting for it would leave every
      // attached client staring at a live-looking dead terminal in the gap.
      // finish() is one-shot: whichever of the two arrives first is the only
      // one that fans out.
      s.finish?.();
    },

    remove(id) {
      const s = sessions.get(id);
      if (!s) return;
      const handle = s.handle;
      s.handle = undefined;
      handle?.kill();
      if (s.detectTimer) clearInterval(s.detectTimer);
      s.detectTimer = undefined;
      // The same one-shot as stop(). This used to notify by hand AND leave
      // s.handle set, so the pty's later onExit called onExit() a second time
      // on clients that had already been told the session was over.
      s.finish?.();
      // A session that never started has no finish(); its clients still need
      // to hear that it is gone.
      if (!s.finish) {
        for (const rec of s.clients) { try { rec.client.onExit(); } catch { /* gone */ } }
        s.clients.clear();
      }
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
 * Every transcript id already on disk for a project folder.
 *
 * Sampled immediately before a spawn, so it is the "everyone else" set: an
 * earlier Belay session in the same project, a `claude` the user is running in
 * his own terminal in that folder, last week's conversation. Returns null when
 * the projects directory cannot be read at all, because "I could not look" and
 * "there is nothing there" lead to opposite decisions.
 */
export function transcriptIdsFor(cwd: string, root: string = PROJECTS_ROOT): Set<string> | null {
  // No projects directory at all is "could not look", not "nothing there":
  // scanSessions answers both with an empty list, and the two lead to opposite
  // decisions about a saved conversation.
  if (!existsSync(root)) return null;
  let found: ReturnType<typeof scanSessions>;
  try { found = scanSessions(root, new Set()); } catch { return null; }
  const out = new Set<string>();
  for (const s of found) if (s.cwd === cwd) out.add(s.claudeSessionId);
  return out;
}

/**
 * Which Claude session id this pty ended up writing to.
 *
 * A stream-json child announces its session id on stdout; the interactive CLI
 * does not tell us anything, so the id has to be recovered from the transcript
 * Claude Code writes to disk. "Newest transcript for this folder" is not good
 * enough to identify it: the app allows two Belay pty sessions in one project,
 * and the user can have a `claude` of his own open in that folder at the same
 * time. All three write transcripts to the same directory, all three look
 * equally new, and latching onto the wrong one means that after a host restart
 * a session revives into somebody else's conversation — which is worse than
 * not reviving at all, because it looks like it worked.
 *
 * So the test is identity, not recency: the transcript must not have existed
 * when this pty spawned (`before`, sampled by transcriptIdsFor), and it must
 * be the only such transcript. Two new ones means two `claude` processes
 * started in this folder since the spawn and neither can be proved ours, so
 * nothing is recorded — this run, and every run after it, until exactly one
 * candidate stands. Best effort by design: without an id the session still
 * works perfectly, it just cannot be revived with --resume after a restart.
 */
export function detectClaudeSessionId(
  cwd: string,
  since: number,
  before: ReadonlySet<string> = new Set(),
  root: string = PROJECTS_ROOT,
): string | null {
  const fresh: string[] = [];
  for (const s of scanSessions(root, new Set())) {
    if (s.cwd !== cwd) continue;
    // Somebody else's, and it was already theirs before we existed.
    if (before.has(s.claudeSessionId)) continue;
    // A second of slack: the transcript is created around the spawn, and file
    // mtimes and Date.now() do not agree to the millisecond.
    if (s.mtime < since - 1000) continue;
    fresh.push(s.claudeSessionId);
  }
  // Exactly one unclaimed, new transcript, or no answer at all.
  return fresh.length === 1 ? fresh[0] : null;
}
