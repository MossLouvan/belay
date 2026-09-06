// "Is somebody driving this session right now?" — decided from the transcript
// file alone. Claude Code appends to ~/.claude/projects/<dir>/<uuid>.jsonl on
// every turn, so the file's last write is the only honest signal a host has
// about a session it did not start: there is no process to watch, no lock to
// read, and the terminal that owns it could be on another display. Pure so
// the index, the sockets and the tests all agree on one definition.

/**
 * A session whose transcript was written inside this window counts as LIVE.
 * 90 seconds: a working turn writes at least every few seconds (each tool
 * call and result is a line), so a minute and a half of silence means the
 * CLI is sitting at its prompt or gone — either way the phone may safely
 * take over. Shorter windows flapped between tool calls; longer ones held
 * the "watching" state past the point the terminal had clearly been closed.
 */
export const LIVE_WINDOW_MS = 90_000;

/** True while `lastWriteAt` falls inside the live window. Unknown = quiet. */
export function isLive(lastWriteAt: number | undefined, now: number, windowMs = LIVE_WINDOW_MS): boolean {
  if (lastWriteAt === undefined || !Number.isFinite(lastWriteAt)) return false;
  return now - lastWriteAt >= 0 && now - lastWriteAt < windowMs;
}

/**
 * When a live session will next need re-judging: the instant its window
 * closes, or null when it is already quiet. The index uses this to flip
 * `live` off on time instead of waiting for the next unrelated event.
 */
export function liveUntil(lastWriteAt: number | undefined, windowMs = LIVE_WINDOW_MS): number | null {
  if (lastWriteAt === undefined || !Number.isFinite(lastWriteAt)) return null;
  return lastWriteAt + windowMs;
}

/**
 * Split a byte buffer into its complete lines and report how many bytes they
 * consumed. The trailing fragment after the last newline is NOT returned —
 * Claude Code writes each JSONL line with a single append, but a read can
 * still land mid-write, and half a JSON object parsed as garbage would drop
 * a real event on the floor. The caller advances its offset by `consumed`
 * and reads the fragment again, whole, once the newline arrives.
 */
export function completeLines(buf: Buffer): { readonly lines: readonly string[]; readonly consumed: number } {
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], consumed: 0 };
  const text = buf.toString('utf8', 0, lastNl);
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  return { lines, consumed: lastNl + 1 };
}
