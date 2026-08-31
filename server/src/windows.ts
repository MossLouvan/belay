// Validation and shaping for the per-window ("seamless") remoting path.
//
// The native helper hands out window handles as decimal strings — JSON numbers
// are doubles and a 64-bit HWND does not survive that round trip — and takes
// them back the same way. Everything a client sends about a window arrives as
// untrusted text, so it is checked here before it reaches the helper, and the
// helper's own answers are re-shaped here before they reach a client.
//
// Nothing in this module talks to the helper. That is what makes it testable.

/** One window as the native helper reports it. */
export interface RawWindow {
  id: string;
  title: string;
  app: string;
  X: number;
  Y: number;
  W: number;
  H: number;
  minimized: boolean;
  z: number;
}

/**
 * A window handle from an untrusted source, or undefined.
 *
 * Only a run of digits is accepted. The handle is opaque to everything above
 * the helper, so there is nothing to interpret — but it is placed into a
 * command the helper parses, and "digits only" is what keeps that from being a
 * place where anything else can be smuggled in. Length is bounded because a
 * 64-bit value cannot need more than 20 digits, and an unbounded string here
 * would be an unbounded string in the helper's parser.
 */
export function windowIdOf(raw: unknown): string | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^[0-9]{1,20}$/.test(trimmed)) return undefined;
  // A handle of zero is Win32's "no window", and the helper reads it as such.
  return /^0+$/.test(trimmed) ? undefined : trimmed;
}

/**
 * Titles are shown in a client's window chrome, so they are length-capped and
 * stripped of control characters — a window can call itself anything at all,
 * including a string of newlines or terminal escape sequences.
 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
}

/**
 * The helper's window list, sanitized for a client.
 *
 * Entries without a usable handle are dropped: a client cannot ask for them,
 * and showing a row that does nothing when clicked is worse than not showing
 * it. Everything else is coerced rather than dropped, so a window with odd
 * geometry still appears and can still be opened.
 */
export function sanitizeWindows(raw: unknown): RawWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: RawWindow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const w = entry as Record<string, unknown>;
    const id = windowIdOf(w.id);
    if (id === undefined) continue;
    if (out.some((existing) => existing.id === id)) continue;
    out.push({
      id,
      title: cleanTitle(w.title),
      app: cleanTitle(w.app).slice(0, 40),
      X: intOr(w.X, 0),
      Y: intOr(w.Y, 0),
      W: intOr(w.W, 0),
      H: intOr(w.H, 0),
      minimized: w.minimized === true,
      z: intOr(w.z, out.length),
    });
  }
  return out;
}

function intOr(raw: unknown, fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * Windows that make sense to open in a client.
 *
 * A minimized window has no pixels to stream — the host cannot print a window
 * that is not laid out — so it is listed but not offered, and the client says
 * why rather than opening a window that stays black.
 */
export function openableWindows(windows: readonly RawWindow[]): RawWindow[] {
  return windows.filter((w) => !w.minimized && w.W > 0 && w.H > 0);
}
