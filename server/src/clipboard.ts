// Validation and shaping for the clipboard sync path (/clipboard).
//
// Both directions cross a trust boundary: a POST body arrives from the phone
// as untrusted JSON, and the native helper's reply to a `get` is re-shaped
// before it reaches a client. Nothing in this module talks to the helper —
// that is what makes it testable.

/**
 * Ceiling on clipboard text in either direction, in UTF-16 code units (what
 * `String.length` counts). Generous enough for real copy/paste — pages of
 * text, whole source files — while staying far under the 2 MB JSON body limit
 * and keeping a single native call cheap. The macOS helper enforces the same
 * number one layer down (`HostClipboard.maxTextUnits` in
 * server/native/mac/Clipboard.swift), as does the Windows helper
 * (BelayHostClipboard.MaxTextUnits), so a caller that reaches a helper by
 * another route still cannot push an unbounded string.
 */
export const MAX_CLIPBOARD_UNITS = 100_000;

/** What a client gets back from GET /clipboard. */
export interface ClipboardReadout {
  readonly text: string;
  /** True when the host's clipboard held more than the cap and was cut. */
  readonly truncated: boolean;
}

/** A validated POST /clipboard body, or the refusal to send instead. */
export type ClipboardSetRequest =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Validate an untrusted POST /clipboard body.
 *
 * `text` must be an actual string — no coercion of numbers or objects, because
 * whatever passes here is placed verbatim onto the host's clipboard and will
 * be pasted into arbitrary applications. An empty string is allowed: it is how
 * a client clears the host clipboard. Oversize is 413 with the limit named, so
 * the phone can say exactly why the push was refused.
 */
export function parseClipboardSet(body: unknown): ClipboardSetRequest {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'request body must be a JSON object with a `text` string' };
  }
  const text = (body as Record<string, unknown>).text;
  if (typeof text !== 'string') {
    return { ok: false, status: 400, error: '`text` must be a string' };
  }
  if (text.length > MAX_CLIPBOARD_UNITS) {
    return {
      ok: false,
      status: 413,
      error: `clipboard text is ${text.length} characters, over the ${MAX_CLIPBOARD_UNITS} limit for one push`,
    };
  }
  return { ok: true, text };
}

/**
 * Shape the native helper's `clipboard get` reply for a client.
 *
 * The helper caps on its own side too, but its reply is a boundary of its own:
 * an old or foreign helper could answer with anything, so a non-string
 * collapses to empty rather than crashing the route, and an over-cap string is
 * cut here as well. The cut lands on `.length` (UTF-16 units) to match the
 * limit the POST side enforces; `truncatedAtSafePoint` then backs off one unit
 * if the cut would split a surrogate pair, so the client never receives a
 * lone half of an emoji.
 */
export function shapeClipboardGet(reply: unknown): ClipboardReadout {
  const raw =
    typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>).text : undefined;
  if (typeof raw !== 'string') return { text: '', truncated: false };

  const helperSaysTruncated =
    typeof reply === 'object' && reply !== null && (reply as Record<string, unknown>).truncated === true;

  if (raw.length <= MAX_CLIPBOARD_UNITS) return { text: raw, truncated: helperSaysTruncated };
  return { text: truncatedAtSafePoint(raw, MAX_CLIPBOARD_UNITS), truncated: true };
}

/**
 * Cut `text` to at most `limit` UTF-16 units without splitting a surrogate
 * pair. If the unit just inside the cut is a high surrogate whose partner
 * falls outside, the cut backs off one unit — losing one whole character,
 * never emitting half of one.
 */
export function truncatedAtSafePoint(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const lastUnit = text.charCodeAt(limit - 1);
  const isHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return text.slice(0, isHighSurrogate ? limit - 1 : limit);
}
