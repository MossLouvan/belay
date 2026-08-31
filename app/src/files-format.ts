// Pure helpers behind the Files screen: sizes, timestamps, path crumbs,
// Finder-style "kind" labels, sorting and the binary-content heuristic. Kept
// out of `app/` because expo-router turns every file under that directory into
// a route. Navigation history and Go-to-Folder parsing live in `src/files/`.

import type { FileEntry } from './api';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

export type Category = 'folder' | 'code' | 'text' | 'image' | 'media' | 'archive' | 'binary' | 'doc' | 'other';

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Hosts have reported both seconds and milliseconds, so normalise defensively. */
export function toMillis(mtime: number): number {
  if (!Number.isFinite(mtime) || mtime <= 0) return 0;
  return mtime < 1e12 ? mtime * 1000 : mtime;
}

export function formatWhen(mtime: number, now: number): string {
  const ms = toMillis(mtime);
  if (ms === 0) return '';
  const delta = now - ms;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
}

/**
 * The header's freshness stamp: "as of 14:02". A signpost must be seen before
 * the need arises — this line lives in the fixed header, proving the listing's
 * age and implying it can be renewed, where the old footer hint only taught
 * users who scrolled past their whole home directory. Hand-rolled HH:MM (not
 * toLocaleTimeString) so the stamp is deterministic under test and never grows
 * an AM/PM suffix the 11pt header line has no room for.
 */
export function formatAsOf(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `as of ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const EXTENSION_CATEGORIES: Readonly<Record<string, Category>> = Object.freeze(
  Object.fromEntries([
    ...'ts,tsx,js,jsx,mjs,cjs,py,rb,go,rs,java,c,cc,cpp,h,hpp,cs,swift,kt,sh,zsh,bash,ps1,php,sql,lua,vue,svelte'
      .split(',')
      .map((e) => [e, 'code' as Category]),
    ...'txt,md,markdown,log,json,yml,yaml,toml,ini,cfg,conf,xml,csv,tsv,env,lock,gitignore'
      .split(',')
      .map((e) => [e, 'text' as Category]),
    ...'png,jpg,jpeg,gif,webp,svg,heic,bmp,ico,tiff'.split(',').map((e) => [e, 'image' as Category]),
    ...'mp4,mov,mkv,avi,webm,mp3,wav,m4a,flac,aac,ogg'.split(',').map((e) => [e, 'media' as Category]),
    ...'zip,tar,gz,bz2,xz,7z,rar,dmg,iso'.split(',').map((e) => [e, 'archive' as Category]),
    ...'exe,dll,so,dylib,bin,o,a,msi,pkg,app,class,wasm'.split(',').map((e) => [e, 'binary' as Category]),
    ...'pdf,doc,docx,xls,xlsx,ppt,pptx,pages,numbers,key'.split(',').map((e) => [e, 'doc' as Category]),
  ])
);

/** Category from a bare filename — what the viewer dispatch needs, since a
 * file being opened is by definition not a folder. */
export const categoryOfName = (name: string): Category =>
  EXTENSION_CATEGORIES[extensionOf(name)] ?? 'other';

export const categoryOf = (entry: FileEntry): Category =>
  entry.dir ? 'folder' : categoryOfName(entry.name);

// --- kind labels -------------------------------------------------------------

// Audio and video share one colour category, but "MP3 audio" and "MOV movie"
// read very differently, so the split is re-derived from the extension.
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg']);

const CATEGORY_KINDS: Readonly<Record<Category, string>> = Object.freeze({
  folder: 'Folder',
  code: 'source',
  text: 'text',
  image: 'image',
  media: 'movie',
  archive: 'archive',
  binary: 'binary',
  doc: 'document',
  other: 'file',
});

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Finder's "Kind" column: "PNG image", "TS source", "Folder" — a plain-English
 * word for what a thing is, which on a small screen beats a bare extension.
 */
export function kindOf(entry: FileEntry): string {
  const category = categoryOf(entry);
  if (category === 'folder') return 'Folder';
  const ext = extensionOf(entry.name);
  const noun = category === 'media' && AUDIO_EXTENSIONS.has(ext) ? 'audio' : CATEGORY_KINDS[category];
  if (!ext) return category === 'other' ? 'Document' : capitalize(noun);
  return `${ext.toUpperCase()} ${noun}`;
}

// --- sorting -----------------------------------------------------------------

export type SortKey = 'name' | 'kind' | 'size' | 'date';

/**
 * The direction a freshly tapped column starts in. Name and kind read top-down
 * alphabetically; size and date lead with biggest/newest because that is what
 * you are looking for when you sort by them (Finder does the same for date).
 */
export const defaultDescending = (key: SortKey): boolean => key === 'size' || key === 'date';

const byName = (a: FileEntry, b: FileEntry): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

export function sortEntries(
  entries: readonly FileEntry[],
  key: SortKey,
  descending: boolean
): readonly FileEntry[] {
  const direction = descending ? -1 : 1;
  const compare = (a: FileEntry, b: FileEntry): number => {
    // Folders lead regardless of key or direction — Finder offers that as
    // "keep folders on top", and on a phone a folder buried between ten
    // thousand files cannot be reached any other way.
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (key === 'size') return direction * (a.size - b.size) || byName(a, b);
    if (key === 'date') return direction * (toMillis(a.mtime) - toMillis(b.mtime)) || byName(a, b);
    if (key === 'kind') return direction * kindOf(a).localeCompare(kindOf(b)) || byName(a, b);
    return direction * byName(a, b);
  };
  return [...entries].sort(compare);
}

/** Splits a host path into tappable segments, handling POSIX and Windows. */
export function crumbsFor(path: string): readonly Crumb[] {
  if (!path) return [];
  const windows = /^[A-Za-z]:/.test(path) || (path.includes('\\') && !path.startsWith('/'));
  const separator = windows ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return windows ? [] : [{ label: '/', path: '/' }];
  const crumbs: Crumb[] = [];
  if (!windows) crumbs.push({ label: '/', path: '/' });
  parts.forEach((part, index) => {
    const joined = parts.slice(0, index + 1).join(separator);
    crumbs.push({ label: part, path: windows ? joined + (index === 0 ? separator : '') : `/${joined}` });
  });
  return crumbs;
}

export const parentOf = (path: string): string | null => {
  const crumbs = crumbsFor(path);
  return crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null;
};

// --- viewer dispatch ---------------------------------------------------------

export type ViewerKind = 'text' | 'markdown' | 'image' | 'pdf' | 'binary';

const VIEWER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'svg']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

/**
 * The categories that are binary through and through — no text fallback would
 * ever show anything but mojibake, so the viewer states what the file is
 * instead of fetching it. `doc` lands here too (minus pdf, which has a real
 * viewer): a .docx is a zip archive whatever its icon suggests.
 */
const BINARY_CATEGORIES = new Set<Category>(['archive', 'media', 'binary', 'doc']);

/**
 * Which viewer a tapped file opens in, decided from its name alone — before
 * any bytes move, so a movie or a disk image is refused with its kind and
 * size instead of being downloaded just to discover it is unreadable.
 */
export function viewerKindOf(name: string): ViewerKind {
  const ext = extensionOf(name);
  if (VIEWER_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (BINARY_CATEGORIES.has(categoryOfName(name))) return 'binary';
  // Everything else is worth attempting as text; looksBinary on the fetched
  // content catches extensionless binaries.
  return 'text';
}

/** SVG needs its own rendering path on native — RN's <Image> is raster-only. */
export const isSvgName = (name: string): boolean => extensionOf(name) === 'svg';

/**
 * Client-side mirrors of the host's /files/raw ceilings (server/src/files-raw.ts).
 * Duplicated on purpose: checking the listed size here fails fast with the
 * same refusal the host would send, without a round trip that was always
 * going to 413.
 */
export const IMAGE_PREVIEW_LIMIT = 25 * 1024 * 1024;
export const PDF_PREVIEW_LIMIT = 50 * 1024 * 1024;

/** The reason a file cannot be previewed at this size, or null when it can. */
export function previewTooLarge(kind: ViewerKind, size: number): string | null {
  const limit = kind === 'image' ? IMAGE_PREVIEW_LIMIT : kind === 'pdf' ? PDF_PREVIEW_LIMIT : null;
  if (limit === null || size <= limit) return null;
  return `This file is ${formatSize(size)} — over the ${formatSize(limit)} preview limit for ${kind === 'pdf' ? 'PDFs' : 'images'}.`;
}

// --- binary detection --------------------------------------------------------

const ESC = 0x1b;
const SAMPLE_BYTES = 4096;
/** Above this share of unprintable bytes, the content is not worth rendering. */
const ODD_RATIO = 0.08;

/**
 * ESC only counts as an odd byte when it is *not* introducing an escape
 * sequence. A colourised `build.log`, `pytest.log` or a saved `script(1)`
 * transcript is full of `ESC [ … m`, and counting every one of those pushed
 * ordinary developer logs over the threshold and hid them behind the "this
 * looks like a binary file" wall.
 */
const isEscapeIntroducer = (code: number): boolean => code >= 0x20 && code <= 0x7e;

/** Heuristic: mojibake and NUL bytes mean the server handed us a binary blob. */
export function looksBinary(content: string): boolean {
  const sample = content.slice(0, SAMPLE_BYTES);
  if (sample.length === 0) return false;
  if (sample.includes('\u0000')) return true;
  let odd = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === ESC && i + 1 < sample.length && isEscapeIntroducer(sample.charCodeAt(i + 1))) continue;
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) odd += 1;
  }
  return odd / sample.length > ODD_RATIO;
}

// --- errors ------------------------------------------------------------------

export const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'the host could not complete that request';

// "outside the allowed" is the exact phrase the host uses when its allow-list
// refuses a path (server/src/files.ts) — without it, that refusal rendered as
// a generic network failure instead of the calmer "would not open" banner.
export const isDenied = (message: string): boolean =>
  /denied|EACCES|EPERM|not permitted|forbidden|outside the allowed/i.test(message);
