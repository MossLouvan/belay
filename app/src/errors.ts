// The one place an unknown thrown value becomes a sentence a person can read.
//
// Every `catch` in the app used to end in some variant of `String(e)`. That is
// correct exactly when the thrown value is a string and wrong for everything
// else: a rejected fetch, a native module's plain object, a null from a
// cancelled promise — each renders as `[object Object]`, `null` or an empty
// string, straight into a banner the user is supposed to act on. Worse, an
// empty message passes a truthiness check and leaves a dangling em dash.
//
// So: one pure function, one closed set of outcomes. Either the error carries
// real prose, or the caller's fallback speaks. Never a stringified object,
// never an empty string, never a stack trace.

/** The last resort when nothing readable survived the throw. */
export const GENERIC_FAILURE = 'something went wrong';

/**
 * A human-readable sentence for any thrown value.
 *
 * Accepts an `Error` with a message, a non-empty string, or anything carrying
 * a string `message` (native modules and fetch polyfills throw these). Every
 * other shape — objects, null, undefined, numbers, empty strings — resolves to
 * `fallback`, because a user cannot act on `[object Object]`.
 *
 * Pure and total: never throws, never returns an empty string.
 */
export function humanMessage(error: unknown, fallback: string = GENERIC_FAILURE): string {
  const clean = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  // Reading `.message` can itself throw — a getter on a hostile or
  // half-constructed object — and an error handler that throws takes the
  // screen down with it.
  const messageOf = (value: unknown): string | null => {
    try {
      if (typeof value !== 'object' || value === null) return null;
      return clean((value as { message?: unknown }).message);
    } catch {
      return null;
    }
  };

  const own = messageOf(error);
  if (own !== null) return own;
  const direct = clean(error);
  if (direct !== null) return direct;
  return clean(fallback) ?? GENERIC_FAILURE;
}

/**
 * `"<what failed> — <why>"`, with the dash only when there is a "why".
 *
 * The dangling-em-dash bug in one place: several call sites built this string
 * by hand and every one of them could produce `Recording failed — ` when the
 * throw carried nothing readable.
 */
export function failureLine(what: string, error: unknown, fallback?: string): string {
  const why = humanMessage(error, fallback ?? '');
  return why === GENERIC_FAILURE || why === '' ? what : `${what} — ${why}`;
}
