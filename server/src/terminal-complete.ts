// The host half of tab completion for the app's line-based terminal input.
//
// Completion is the shell's feature, not ours: only the shell knows its own
// completers, $fpath, aliases and cwd. So a request runs a short dance against
// the live pty — write the line, write a tab, capture what the shell echoes,
// then kill the shell's edit line — and the raw capture goes back to the app,
// which does the parsing (app/src/terminal/complete.ts). The host owns the
// parts that only it can do: keeping the echo OUT of the transcript, bounding
// the wait, holding back user keystrokes that would land mid-dance, and above
// all restoring the invariant that the shell's line buffer is empty afterwards
// — that invariant is what makes the phone's TextInput the only line buffer in
// the system, so the two can never drift apart.

import type { TermSession } from './terminal.js';

export interface CompleterOptions {
  /** Echo is considered finished this long after the last chunk. */
  readonly settleMs: number;
  /** Hard ceiling on the whole capture, shell answering or not. */
  readonly maxMs: number;
  /** Absorbed after cleanup so the kill-line's own redraw never leaks. */
  readonly graceMs: number;
  /** Discarded after the pre-dance widening, absorbing the SIGWINCH redraw. */
  readonly resizeMs: number;
}

// The settle window must outlast the gap between a shell's burst of redraw
// writes (single-digit ms locally) but stay short enough that the whole dance
// feels like a keypress. The ceiling covers a completer that genuinely works
// (a first `git <tab>` can load completion functions) without ever letting a
// hung one freeze the input for long.
export const DEFAULT_COMPLETER_OPTIONS: CompleterOptions = Object.freeze({
  settleMs: 150,
  maxMs: 1500,
  graceMs: 120,
  resizeMs: 80,
});

/**
 * The pty is widened to this for the duration of a dance. On a phone the pty
 * is narrow, so almost any real command line soft-wraps — and a wrapped echo
 * cannot be replayed into a line without knowing the prompt's width, which
 * nobody outside the shell does. At 400 columns nothing the input box can
 * hold ever wraps, so the echo stays a single visual line the app can read.
 * The SIGWINCH redraws this causes (one on widening, one on restore) happen
 * entirely inside the capture/grace windows, so the transcript never sees
 * them.
 */
export const DANCE_COLS = 400;

/** Echo kept per dance. A capture bigger than this is a runaway full-screen
    program, not a completion — the app will classify it unreadable anyway. */
const MAX_RAW_CHARS = 32 * 1024;
const MAX_LINE_CHARS = 2048;
const POLL_MS = 25;

// Restoring the empty-buffer invariant, per platform. POSIX sends Ctrl-U
// twice: if the shell is sitting at a "Display all N possibilities?" question,
// the first ^U is consumed as the "no" answer and the second kills the line;
// with no question pending the first kills the line and the second is a no-op
// on an empty one. Windows PSReadLine (and cmd) clear the line on Escape, and
// a second Escape on an empty line is likewise inert.
const CLEANUP_POSIX = '\x15\x15';
const CLEANUP_WINDOWS = '\x1b\x1b';

export type CompletionStatus = 'ok' | 'busy' | 'unsupported';

export interface CompletionReply {
  readonly status: CompletionStatus;
  readonly raw?: string;
  readonly shell?: 'posix' | 'windows';
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface Completer {
  /**
   * Routes a pty output chunk: returns it untouched for the transcript, or
   * swallows it (returning null) while a dance is capturing.
   */
  filter(data: string): string | null;
  /**
   * Routes app keystrokes to the shell. During a dance they are held back —
   * a `\r` landing mid-dance would execute the half-completed line — and
   * flushed in order once the shell's buffer is empty again.
   */
  write(data: string): void;
  /**
   * Runs one completion dance, restoring the given real terminal size after
   * the pty is temporarily widened. Never rejects; failure modes are statuses.
   */
  complete(text: string, size: TerminalSize): Promise<CompletionReply>;
}

/**
 * The line the app asks to complete, made safe to replay as keystrokes.
 * Control bytes are stripped rather than escaped because none of them can be
 * part of a typed command line — and a smuggled `\r` or `\x03` would execute
 * or interrupt instead of complete. Over-long lines are refused outright.
 */
export function sanitizeCompletionLine(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  if (text.length === 0 || text.length > MAX_LINE_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f]/g, '');
  return clean.length > 0 ? clean : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createCompleter(
  session: TermSession,
  options: CompleterOptions = DEFAULT_COMPLETER_OPTIONS,
  platform: NodeJS.Platform = process.platform,
): Completer {
  let capturing = false;
  let raw = '';
  let lastChunkAt = 0;
  let deferred: string[] = [];

  const filter = (data: string): string | null => {
    if (!capturing) return data;
    lastChunkAt = Date.now();
    if (raw.length < MAX_RAW_CHARS) raw = raw + data.slice(0, MAX_RAW_CHARS - raw.length);
    return null;
  };

  const write = (data: string): void => {
    if (capturing) {
      deferred = [...deferred, data];
      return;
    }
    session.write(data);
  };

  const complete = async (text: string, size: TerminalSize): Promise<CompletionReply> => {
    // A piped shell has no line editor listening for the tab at all; naming
    // that here lets the app say so instead of shipping a dead key.
    if (session.mode !== 'pty') return { status: 'unsupported' };
    if (capturing) return { status: 'busy' };

    capturing = true;
    raw = '';
    try {
      // Widen first, then throw away the shell's redraw of its (empty) prompt
      // line — only the echo of our own keystrokes may reach the classifier.
      session.resize(DANCE_COLS, size.rows);
      await sleep(options.resizeMs);
      raw = '';
      const startedAt = Date.now();
      lastChunkAt = startedAt;
      session.write(`${text}\t`);
      // Wait for the echo to settle: done when the shell has answered and then
      // gone quiet, or when the ceiling passes with or without an answer.
      for (;;) {
        await sleep(POLL_MS);
        const now = Date.now();
        if (now - startedAt >= options.maxMs) break;
        if (raw.length > 0 && now - lastChunkAt >= options.settleMs) break;
      }
      return {
        status: 'ok',
        raw,
        shell: platform === 'win32' ? 'windows' : 'posix',
      };
    } finally {
      // The invariant, unconditionally — timeout and error paths included.
      // The kill-line makes its own echo (erase sequences, sometimes a full
      // prompt redraw after a candidate list), which the grace period absorbs
      // so it can never clobber the transcript's prompt line.
      try {
        session.write(platform === 'win32' ? CLEANUP_WINDOWS : CLEANUP_POSIX);
        session.resize(size.cols, size.rows);
      } catch { /* shell died mid-dance */ }
      await sleep(options.graceMs);
      capturing = false;
      const held = deferred;
      deferred = [];
      for (const chunk of held) session.write(chunk);
    }
  };

  return { filter, write, complete };
}
