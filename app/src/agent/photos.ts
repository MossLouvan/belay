// The pure vocabulary of sending phone photos into a Claude session: the caps
// the phone enforces before a byte moves, the boundary parsing for the host's
// replies, and the failure lines the composer shows. No react-native imports —
// this file runs under node:test.
//
// The pixels' whole journey is phone → host → session project folder; the
// host re-validates everything (type by magic bytes, size, count,
// confinement), so the checks here exist to fail fast with a message the user
// can act on, not to be the security boundary.

/** Mirrors IMAGES in server/src/images.ts — the phone refuses what the host would. */
export const PHOTOS = Object.freeze({
  maxImages: 4,
  maxImageBytes: 12 * 1024 * 1024,
} as const);

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** The slice of a picked asset this module needs. */
export interface PickedPhoto {
  readonly base64?: string | null;
}

export interface UploadPlan {
  /** The base64 payloads to upload, in pick order. */
  readonly uploads: readonly string[];
  /** One line naming why nothing (or not everything) can go, or null. */
  readonly problem: string | null;
}

/**
 * Decide what a picker result becomes. All-or-nothing on purpose: silently
 * sending two of three photos would hand Claude a different question than the
 * one the user composed, which is worse than a refusal that names the fix.
 */
export function planUpload(picked: readonly PickedPhoto[]): UploadPlan {
  const uploads = picked
    .map((asset) => asset.base64 ?? '')
    .filter((b64) => b64.length > 0);
  if (uploads.length === 0) {
    return { uploads: [], problem: picked.length === 0 ? null : 'the photos could not be read from the library' };
  }
  if (uploads.length > PHOTOS.maxImages) {
    return { uploads: [], problem: `at most ${PHOTOS.maxImages} photos can be sent at once` };
  }
  const mb = Math.round(PHOTOS.maxImageBytes / (1024 * 1024));
  if (uploads.some((b64) => base64Bytes(b64) > PHOTOS.maxImageBytes)) {
    return { uploads: [], problem: `a photo is too large to send (over ${mb} MB)` };
  }
  return { uploads, problem: null };
}

/** Parse the host's `/images/send` reply. Anything unrecognised collapses to zero, not NaN. */
export function parseImagesSent(raw: unknown): { files: number; relDir: string } {
  if (typeof raw !== 'object' || raw === null) return { files: 0, relDir: '' };
  const msg = raw as Record<string, unknown>;
  const files = typeof msg.files === 'number' && Number.isFinite(msg.files) && msg.files > 0
    ? Math.floor(msg.files)
    : 0;
  return { files, relDir: typeof msg.relDir === 'string' ? msg.relDir : '' };
}

// ---- failure vocabulary -----------------------------------------------------
//
// §11.4: state what was observed, offer a way forward; none of it blames the
// user. Camera denial is a Settings problem — iOS only re-asks there.

export const CAMERA_DENIED_MESSAGE =
  'camera access is off for Tether — allow it in Settings to take a photo for Claude';

export function uploadFailureMessage(detail: string): string {
  return `the photos could not be sent — ${detail}`;
}

/** What the busy photo control claims to be doing. */
export function sendingPhotosLabel(count: number): string {
  return count === 1 ? 'Sending the photo to Claude…' : `Sending ${count} photos to Claude…`;
}
