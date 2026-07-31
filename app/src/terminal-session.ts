// Terminal wire protocol and output backpressure.
//
// Both halves of this file exist because the far end is a process nobody here
// controls: messages arrive from a WebSocket and are validated rather than
// trusted, and output can arrive faster than a phone can render it.

/** Output is batched at this cadence; a chatty process must not re-render per byte. */
export const FLUSH_MS = 40;

/**
 * Characters of raw output held between flushes. `yes` or a `cat` of a large
 * file produces output faster than the parser and the list can consume it, and
 * an uncapped buffer turns that into unbounded memory growth. A quarter of a
 * megabyte is far more than one 40ms frame can ever render, so hitting this cap
 * means the stream is already outrunning the UI.
 */
export const MAX_BUFFERED_CHARS = 256 * 1024;

export interface ServerMessage {
  readonly type: string;
  readonly data?: string;
  readonly mode?: string;
}

/** Messages arrive from the network, so nothing about them is assumed. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string') return null;
  return {
    type: record.type,
    data: typeof record.data === 'string' ? record.data : undefined,
    mode: typeof record.mode === 'string' ? record.mode : undefined,
  };
}

// --- output buffer -----------------------------------------------------------

export interface OutputBuffer {
  /** Raw bytes waiting for the next flush. */
  readonly text: string;
  /** Characters discarded since the last drain, reported to the user on drain. */
  readonly dropped: number;
}

export const EMPTY_OUTPUT: OutputBuffer = Object.freeze({ text: '', dropped: 0 });

/**
 * Appends a chunk, discarding from the *oldest* end once the buffer is over
 * budget — the newest output is the part worth keeping on screen. The cut can
 * land inside an escape sequence, which the parser tolerates (a body with no
 * introducer prints as text, a lone ESC is dropped); losing a few bytes at a
 * seam is the price of not losing the whole session to an OOM.
 */
export function pushOutput(buffer: OutputBuffer, chunk: string, limit = MAX_BUFFERED_CHARS): OutputBuffer {
  const text = buffer.text + chunk;
  if (text.length <= limit) return { text, dropped: buffer.dropped };
  const excess = text.length - limit;
  return { text: text.slice(excess), dropped: buffer.dropped + excess };
}

/**
 * Empties the buffer. Any drop is announced in the returned text rather than
 * swallowed, so a gap in the transcript is never mistaken for the host's own
 * output. The notice leads because the dropped bytes preceded what survived.
 */
export function drainOutput(buffer: OutputBuffer): { readonly text: string; readonly next: OutputBuffer } {
  if (buffer.text.length === 0 && buffer.dropped === 0) return { text: '', next: EMPTY_OUTPUT };
  const notice =
    buffer.dropped > 0
      ? `\r\n[tether dropped ${buffer.dropped} characters — output arrived faster than it could be drawn]\r\n`
      : '';
  return { text: notice + buffer.text, next: EMPTY_OUTPUT };
}
