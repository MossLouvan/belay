// The two pure rules a shared, multi-client pty needs: what a late attacher
// sees, and how big the terminal is when several people are looking at it.
//
// Both are deliberately here, apart from the process plumbing in agent-pty.ts,
// because both are the kind of thing that is easy to get subtly wrong and
// impossible to notice by eye — a scrollback that cuts mid-escape-sequence
// paints garbage, and a size rule that picks the wrong bound clips somebody's
// screen without ever saying so.

/** A terminal size. Immutable; every producer returns a fresh one. */
export interface TermSize {
  readonly cols: number;
  readonly rows: number;
}

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_SIZE: TermSize = Object.freeze({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });

/** Upper bound on a dimension, matching the terminal tab's own clamp. */
const MAX_DIM = 1000;

/**
 * How much of the session's output is kept for replay. A quarter of a megabyte
 * is a few hundred lines of a build log — enough that walking to the computer
 * shows you the screen you left plus the context above it, small enough that a
 * hundred idle sessions cost less than a browser tab.
 */
export const SCROLLBACK_CAP = 256 * 1024;

/**
 * Append to the scrollback ring, trimming from the front when it overflows.
 *
 * The trim lands on a line boundary rather than at the exact byte budget: a
 * terminal stream is full of multi-byte escape sequences, and a cut in the
 * middle of one replays as literal garbage (`[38;5;214m`) at the top of the
 * new attacher's screen. Cutting after the first newline past the overflow
 * point costs at most one extra line and guarantees the replay starts
 * somewhere a terminal can make sense of.
 *
 * Returns a new string; the input is never mutated.
 */
export function appendScrollback(current: string, chunk: string, cap: number = SCROLLBACK_CAP): string {
  const joined = current + chunk;
  if (joined.length <= cap) return joined;
  const excess = joined.length - cap;
  const boundary = joined.indexOf('\n', excess);
  // No newline in the tail at all (a single enormous line): fall back to a hard
  // cut at the budget, because keeping nothing would be worse than keeping a
  // fragment of one line.
  if (boundary < 0) return joined.slice(joined.length - cap);
  return joined.slice(boundary + 1);
}

/** A dimension a pty will accept: a positive integer in a sane range. */
export function clampDim(raw: unknown, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_DIM);
}

/**
 * The size to give the pty when several clients are attached: the minimum of
 * every attached client's cols and rows, independently.
 *
 * This is tmux's rule, and the reasoning is the same. A pty has exactly one
 * size, so with a phone (60x30) and a laptop (200x50) looking at the same
 * session somebody is going to be wrong. If the pty is sized to the *largest*
 * client, the smaller one silently loses the right-hand columns and the bottom
 * rows — and it loses them invisibly, because the program drawing the screen
 * believes it has room it does not have. Sizing to the smallest means the big
 * screen has unused space around the session, which is obvious, harmless, and
 * correct for everyone: every attached client can see every cell the program
 * drew.
 *
 * Recomputed on attach, detach and any client's own resize. With nobody
 * attached the last size is kept (the fallback) — an unattended session must
 * not be resized to nothing just because the room emptied.
 */
export function minSize(sizes: readonly TermSize[], fallback: TermSize = DEFAULT_SIZE): TermSize {
  if (sizes.length === 0) return fallback;
  let cols = Infinity;
  let rows = Infinity;
  for (const s of sizes) {
    const c = clampDim(s.cols, fallback.cols);
    const r = clampDim(s.rows, fallback.rows);
    if (c < cols) cols = c;
    if (r < rows) rows = r;
  }
  return { cols, rows };
}
