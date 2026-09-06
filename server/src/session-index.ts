// The live index of every Claude Code session on this machine.
//
// discover.ts used to answer "/agent/discovered" with a scan cached for 30
// seconds — which meant a session started in a terminal took up to half a
// minute to appear on the phone, and nothing at all said whether it was
// still being typed into. This replaces the cache with a watcher over
// ~/.claude/projects: one in-memory row per transcript, its last write time
// kept current by fs.watch (recursive on macOS and Windows) or, where
// recursive watching is unsupported, by a 5-second mtime poll. `live` is
// derived from the last write (session-live.ts) and flips off on schedule,
// so the attention push can say "quiet now" without anyone asking.
//
// Everything is best-effort: an unreadable directory yields no rows, a
// watcher that fails to start yields the poll, and no path in here throws
// past its own try. The index is a courtesy over the transcript files; the
// files are the truth.

import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { extractMeta, readHead } from './discover.js';
import type { DiscoveredSession } from './discover.js';
import { isLive, liveUntil } from './session-live.js';

/** One discovered row on the wire: discover.ts's shape plus the live facts. */
export interface LiveDiscoveredSession extends DiscoveredSession {
  readonly live: boolean;
  readonly lastWriteAt: number;
}

interface Indexed {
  readonly id: string;
  readonly file: string;
  readonly cwd: string;
  readonly preview: string;
  readonly lastWriteAt: number;
}

export interface SessionIndexOptions {
  /** Poll interval when recursive watching is unavailable. */
  readonly pollMs?: number;
  /** Safety rescan while a watcher is active — catches missed events. */
  readonly rescanMs?: number;
  /** Rows returned by list(); reads at first scan are bounded by 3× this. */
  readonly cap?: number;
  /** Injected clock for tests. */
  readonly now?: () => number;
  /** Force the poll path (tests, or a platform whose fs.watch lies). */
  readonly watch?: boolean;
}

export interface SessionIndex {
  /** Newest first, capped, minus the ids Belay already wraps. */
  list(exclude?: ReadonlySet<string>): readonly LiveDiscoveredSession[];
  /** One row with its live state, or null. */
  get(id: string): LiveDiscoveredSession | null;
  /** The transcript path for a session, or null when it is not indexed. */
  fileOf(id: string): string | null;
  /** "Some row appeared, moved or went quiet." Returns unhook. */
  onChange(fn: () => void): () => void;
  /** Re-read a single transcript now (the tail streams call this on growth). */
  touch(file: string): void;
  /** Full walk of the root now. */
  rescan(): void;
  start(): void;
  stop(): void;
  /** Which mechanism keeps the index current — for the boot banner. */
  readonly mode: 'watch' | 'poll' | 'off';
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_RESCAN_MS = 60_000;
const DEFAULT_CAP = 100;
/** fs.watch fires several events per append; coalesce them per file. */
const TOUCH_DEBOUNCE_MS = 150;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function createSessionIndex(root: string, opts: SessionIndexOptions = {}): SessionIndex {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const rescanMs = opts.rescanMs ?? DEFAULT_RESCAN_MS;
  const cap = opts.cap ?? DEFAULT_CAP;
  const now = opts.now ?? Date.now;
  const wantWatch = opts.watch ?? true;

  const rows = new Map<string, Indexed>();
  const listeners = new Set<() => void>();
  const pendingTouch = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let liveTimer: NodeJS.Timeout | null = null;
  let mode: SessionIndex['mode'] = 'off';
  let started = false;

  const emit = (): void => {
    for (const fn of listeners) { try { fn(); } catch { /* listener's problem */ } }
    armLiveTimer();
  };

  /** Wake exactly when the soonest live row goes quiet, so `live` flips on time. */
  const armLiveTimer = (): void => {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    if (listeners.size === 0) return;
    const t = now();
    let soonest: number | null = null;
    for (const r of rows.values()) {
      if (!isLive(r.lastWriteAt, t)) continue;
      const until = liveUntil(r.lastWriteAt);
      if (until !== null && (soonest === null || until < soonest)) soonest = until;
    }
    if (soonest === null) return;
    liveTimer = setTimeout(() => { liveTimer = null; emit(); }, Math.max(0, soonest - t) + 1);
    liveTimer.unref?.();
  };

  const withLive = (r: Indexed): LiveDiscoveredSession => ({
    claudeSessionId: r.id, cwd: r.cwd, mtime: r.lastWriteAt, preview: r.preview,
    lastWriteAt: r.lastWriteAt, live: isLive(r.lastWriteAt, now()),
  });

  /**
   * Refresh one file's row. Returns true when the index changed. Head reads
   * happen only for new rows and rows still missing a preview — a session's
   * first prompt often lands a few writes after the file is created.
   */
  const refresh = (file: string): boolean => {
    const name = basename(file);
    if (!SESSION_FILE.test(name)) return false;
    const id = name.slice(0, -6);
    let mtime: number;
    try { mtime = statSync(file).mtimeMs; }
    catch { return rows.delete(id); }
    const known = rows.get(id);
    if (known && known.lastWriteAt === mtime) return false;
    if (known && known.preview) {
      rows.set(id, { ...known, lastWriteAt: mtime });
      return true;
    }
    let meta: { cwd?: string; preview?: string };
    try { meta = extractMeta(readHead(file)); } catch { return false; }
    const cwd = meta.cwd ?? known?.cwd;
    // No recoverable cwd, or the project folder is gone — nothing to show.
    if (!cwd || !existsSync(cwd)) return known ? rows.delete(id) : false;
    rows.set(id, { id, file, cwd, preview: meta.preview ?? '', lastWriteAt: mtime });
    return true;
  };

  const rescan = (): void => {
    let changed = false;
    const seen = new Set<string>();
    let dirs: string[] = [];
    try { dirs = readdirSync(root); } catch { dirs = []; }
    const candidates: { file: string; mtime: number }[] = [];
    for (const dir of dirs) {
      const full = join(root, dir);
      let files: string[] = [];
      try {
        if (!statSync(full).isDirectory()) continue;
        files = readdirSync(full);
      } catch { continue; }
      for (const f of files) {
        if (!SESSION_FILE.test(f)) continue;
        const file = join(full, f);
        try { candidates.push({ file, mtime: statSync(file).mtimeMs }); } catch { /* vanished */ }
      }
    }
    // Newest first so the bounded first scan spends its head reads on the
    // sessions most likely to be listed.
    candidates.sort((a, b) => b.mtime - a.mtime);
    let reads = 0;
    for (const c of candidates) {
      const id = basename(c.file).slice(0, -6);
      seen.add(id);
      const known = rows.get(id);
      if (!known && reads >= cap * 3) continue;
      if (!known || !known.preview) reads++;
      if (refresh(c.file)) changed = true;
    }
    for (const id of [...rows.keys()]) {
      if (!seen.has(id)) { rows.delete(id); changed = true; }
    }
    if (changed) emit();
  };

  const touch = (file: string): void => {
    const prior = pendingTouch.get(file);
    if (prior) clearTimeout(prior);
    const t = setTimeout(() => {
      pendingTouch.delete(file);
      if (refresh(file)) emit();
    }, TOUCH_DEBOUNCE_MS);
    t.unref?.();
    pendingTouch.set(file, t);
  };

  const startPoll = (): void => {
    mode = 'poll';
    timer = setInterval(rescan, pollMs);
    timer.unref?.();
  };

  const startWatch = (): boolean => {
    if (!wantWatch) return false;
    try {
      watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (typeof filename !== 'string' || !filename) { rescan(); return; }
        const name = basename(filename);
        if (!SESSION_FILE.test(name)) return;
        touch(join(root, filename));
      });
      watcher.on('error', () => {
        // The watcher died (root removed, handle limit); fall back to polling
        // rather than silently freezing the list.
        try { watcher?.close(); } catch { /* already closed */ }
        watcher = null;
        if (started && timer === null) startPoll();
      });
      mode = 'watch';
      timer = setInterval(rescan, rescanMs);
      timer.unref?.();
      return true;
    } catch {
      watcher = null;
      return false;
    }
  };

  return {
    get mode() { return mode; },
    list(exclude = new Set<string>()) {
      return [...rows.values()]
        .filter((r) => !exclude.has(r.id))
        .sort((a, b) => b.lastWriteAt - a.lastWriteAt)
        .slice(0, cap)
        .map(withLive);
    },
    get(id) {
      const r = rows.get(id);
      return r ? withLive(r) : null;
    },
    fileOf(id) {
      return rows.get(id)?.file ?? null;
    },
    onChange(fn) {
      listeners.add(fn);
      armLiveTimer();
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
      };
    },
    touch,
    rescan,
    start() {
      if (started) return;
      started = true;
      rescan();
      if (!startWatch()) startPoll();
    },
    stop() {
      started = false;
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
      if (timer) { clearInterval(timer); timer = null; }
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
      for (const t of pendingTouch.values()) clearTimeout(t);
      pendingTouch.clear();
      mode = 'off';
    },
  };
}
