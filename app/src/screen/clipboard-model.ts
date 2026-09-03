// Pure logic behind the clipboard sheet: size pre-checks, previews, and the
// one-line notices for every outcome. No React, no network — that is what
// makes it testable from node (see clipboard-model.test.mjs).

/**
 * Mirror of MAX_CLIPBOARD_UNITS on the host (server/src/clipboard.ts), in
 * UTF-16 code units (`String.length`). Checked here first so a giant phone
 * clipboard fails instantly with a message, not after a round trip the host
 * would refuse with a 413 anyway.
 */
export const MAX_CLIPBOARD_UNITS = 100_000;

/** How much of the pulled text the sheet shows as evidence of what arrived. */
export const PREVIEW_UNITS = 140;

/** One line of feedback under the sheet's buttons. */
export interface ClipboardNotice {
  readonly tone: 'ok' | 'bad' | 'dim';
  readonly text: string;
}

/**
 * A single quiet line of the text, for showing what was pulled without
 * reproducing pages of it: runs of whitespace collapse to one space, and the
 * cut lands via the spread operator (code points, not UTF-16 units) so it can
 * never split a surrogate pair.
 */
export function previewOf(text: string, max: number = PREVIEW_UNITS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = [...flat];
  if (points.length <= max) return flat;
  return points.slice(0, max).join('') + '…';
}

/** What a successful pull did — including the pull of nothing. */
export function pulledNotice(text: string, truncated: boolean, copied: boolean): ClipboardNotice {
  if (text.length === 0) return { tone: 'dim', text: 'The computer’s clipboard has no text' };
  if (!copied) {
    // The text arrived but this phone refused the copy (web builds can): the
    // user must not walk away believing it is on their clipboard.
    return { tone: 'bad', text: 'Read the computer’s clipboard, but copying on this phone was refused' };
  }
  const base = `Copied ${text.length.toLocaleString()} characters to this phone`;
  return { tone: 'ok', text: truncated ? `${base} (the computer had more; it was cut at the cap)` : base };
}

/** Pre-flight for a push: is there something sendable on the phone? */
export type PushCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly notice: ClipboardNotice };

export function checkPush(phoneClipboard: string | null): PushCheck {
  if (phoneClipboard === null || phoneClipboard.length === 0) {
    return { ok: false, notice: { tone: 'dim', text: 'This phone’s clipboard has no text to send' } };
  }
  if (phoneClipboard.length > MAX_CLIPBOARD_UNITS) {
    return {
      ok: false,
      notice: {
        tone: 'bad',
        text: `That is ${phoneClipboard.length.toLocaleString()} characters — over the ${MAX_CLIPBOARD_UNITS.toLocaleString()} limit for one push`,
      },
    };
  }
  return { ok: true, text: phoneClipboard };
}

/** What a successful push did. */
export function pushedNotice(length: number): ClipboardNotice {
  return { tone: 'ok', text: `Sent ${length.toLocaleString()} characters to the computer’s clipboard` };
}

/** Any failure, spoken plainly. The api layer already humanizes its errors. */
export function failureNotice(error: unknown): ClipboardNotice {
  const message = error instanceof Error && error.message ? error.message : 'something went wrong';
  return { tone: 'bad', text: message };
}
