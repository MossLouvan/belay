// Following one Claude Code transcript as it grows — the machinery under
// /ws/transcript. A session started in a terminal has no process Belay can
// subscribe to; its JSONL file is the only feed. So: one watcher per file,
// shared by every socket reading it (refcounted), each reader keeping its own
// byte offset and pulling complete lines only. fs.watch on a single file is
// reliable on every platform Belay ships on, but it can still die under us
// (editor-style rename, handle limits), so a 2-second mtime poll backs it.
//
// The tests drive growth with a temp file and never touch the user's
// ~/.claude; nothing in here knows what a session is.

import { statSync, watch, watchFile, unwatchFile } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readTranscriptWindow } from './transcript.js';
import type { TranscriptWindow } from './transcript.js';

/** fs.watch bursts several events per append; coalesce per file. */
const TAIL_DEBOUNCE_MS = 100;
/** The mtime poll that catches whatever fs.watch drops. */
const TAIL_POLL_MS = 2_000;

export interface TailReader {
  /** Everything complete after this reader's offset; advances the offset. */
  next(): TranscriptWindow;
  /** Stop following. The shared watcher closes with its last reader. */
  close(): void;
}

interface Shared {
  readonly file: string;
  readonly readers: Set<() => void>;
  watcher: FSWatcher | null;
  polling: boolean;
  timer: NodeJS.Timeout | null;
  lastSize: number;
}

const shared = new Map<string, Shared>();

function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return -1; }
}

/** Every reader of `file` learns the file may have grown. */
function notify(s: Shared): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    const size = sizeOf(s.file);
    if (size === s.lastSize) return;
    s.lastSize = size;
    for (const fn of s.readers) { try { fn(); } catch { /* reader's problem */ } }
  }, TAIL_DEBOUNCE_MS);
  s.timer.unref?.();
}

function startPoll(s: Shared): void {
  if (s.polling) return;
  s.polling = true;
  watchFile(s.file, { interval: TAIL_POLL_MS, persistent: false }, () => notify(s));
}

function acquire(file: string): Shared {
  const have = shared.get(file);
  if (have) return have;
  const s: Shared = { file, readers: new Set(), watcher: null, polling: false, timer: null, lastSize: sizeOf(file) };
  try {
    s.watcher = watch(file, { persistent: false }, () => notify(s));
    s.watcher.on('error', () => {
      try { s.watcher?.close(); } catch { /* already closed */ }
      s.watcher = null;
    });
  } catch {
    s.watcher = null;
  }
  // The poll always runs: it is cheap, and it is what notices a write the
  // watcher missed. fs.watch just makes the common case instant.
  startPoll(s);
  shared.set(file, s);
  return s;
}

function release(s: Shared): void {
  if (s.readers.size > 0) return;
  shared.delete(s.file);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  try { s.watcher?.close(); } catch { /* already closed */ }
  s.watcher = null;
  if (s.polling) { unwatchFile(s.file); s.polling = false; }
}

/** How many transcript files are currently being followed — for tests. */
export function tailedFileCount(): number {
  return shared.size;
}

/**
 * Follow `file` from `offset` (a byte offset from a prior window). `onGrow`
 * fires — debounced — whenever the file's size changes; the caller then
 * pulls `next()` and sends what came back. Readers on the same file share
 * one watcher.
 */
export function tailTranscript(file: string, offset: number, onGrow: () => void): TailReader {
  const s = acquire(file);
  let at = offset;
  let closed = false;
  s.readers.add(onGrow);
  return {
    next() {
      if (closed) return { events: [], offset: at, size: at };
      const win = readTranscriptWindow(file, at);
      at = win.offset;
      return win;
    },
    close() {
      if (closed) return;
      closed = true;
      s.readers.delete(onGrow);
      release(s);
    },
  };
}
