// The binary side of the read-only file API: metadata + type gating for
// `GET /files/raw`, which streams a file's bytes so the app can show images
// and PDFs instead of mojibake.
//
// Confinement is identical to the text path — the same `resolveInsideRoots`
// from files.ts, so allow-listed roots, realpath'd symlinks and the deny-list
// all apply before a single byte leaves the machine. What is different is the
// gate on *type*: this route only serves formats the app can actually preview.
// The text route already caps everything else at 512 KB, and an "anything"
// byte route would quietly turn a viewer into a bulk download tool.
//
// Sizes are enforced here, before the stream is opened, and the file is then
// streamed rather than buffered — the ceiling protects the phone (which has to
// decode the whole image or PDF in memory), not this process.

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { resolveInsideRoots } from './files.js';

export type RawKind = 'image' | 'pdf';

/**
 * Per-kind byte ceilings.
 *
 * An image over 25 MB is a RAW/panorama the phone would struggle to decode and
 * the link would take ages to move; a PDF gets more headroom because scanned
 * documents are routinely tens of megabytes and render page-by-page. Both are
 * far below the point where a request could tie up the link for minutes.
 */
export interface RawLimits {
  readonly image: number;
  readonly pdf: number;
}

export const RAW_LIMITS: RawLimits = Object.freeze({
  image: 25 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
});

/**
 * Extension → MIME, only for what the app can render. Deliberately not a
 * general MIME database: every entry here is a format someone has to have
 * built a viewer for on the other end.
 */
const RAW_MIME: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
});

/** `.png` is a dotfile, not an extension — same rule as the app's kind labels. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export function mimeOf(name: string): string | null {
  return RAW_MIME[extensionOf(name)] ?? null;
}

export function rawKindOf(name: string): RawKind | null {
  const mime = mimeOf(name);
  if (mime === null) return null;
  return mime === 'application/pdf' ? 'pdf' : 'image';
}

const MB = 1024 * 1024;
const formatBytes = (n: number): string =>
  n >= MB ? `${(n / MB).toFixed(n % MB === 0 ? 0 : 1)} MB` : `${Math.ceil(n / 1024)} KB`;

export interface RawFile {
  /** The real (symlink-free) path, safe to open. */
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly kind: RawKind;
}

/**
 * Validate a caller-supplied path for the raw route and describe it.
 *
 * Everything is checked before any content is touched: confinement first (so a
 * denied path never even learns whether it exists), then that it is a plain
 * file of a servable type under its size ceiling. The caller streams the
 * returned real path; the check-then-open window is the same accepted residual
 * as the rest of the file API (see the header of files.ts).
 */
export async function statRawFile(target: string, limits: RawLimits = RAW_LIMITS): Promise<RawFile> {
  const file = await resolveInsideRoots(target);
  const s = await stat(file);
  if (s.isDirectory()) throw new Error('path is a directory');
  if (!s.isFile()) throw new Error('path is not a regular file');

  const name = basename(file);
  const mime = mimeOf(name);
  const kind = rawKindOf(name);
  if (mime === null || kind === null) {
    throw new Error('no binary preview for this file type');
  }

  const limit = limits[kind];
  if (s.size > limit) {
    throw new Error(
      `file is too large to preview: ${formatBytes(s.size)}, over the ${formatBytes(limit)} limit for ${kind === 'pdf' ? 'PDFs' : 'images'}`,
    );
  }

  return { path: file, name, size: s.size, mime, kind };
}
