// Pure helpers behind the Files screen: sizes, timestamps, path crumbs, sorting
// and the binary-content heuristic. Kept out of `app/` because expo-router turns
// every file under that directory into a route.

import type { FileEntry } from './api';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

export type SortKey = 'name' | 'size' | 'date';

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

export const categoryOf = (entry: FileEntry): Category =>
  entry.dir ? 'folder' : EXTENSION_CATEGORIES[extensionOf(entry.name)] ?? 'other';

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

export function sortEntries(
  entries: readonly FileEntry[],
  key: SortKey,
  descending: boolean
): readonly FileEntry[] {
  const direction = descending ? -1 : 1;
  const compare = (a: FileEntry, b: FileEntry): number => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1; // folders always lead
    if (key === 'size') return direction * (a.size - b.size);
    if (key === 'date') return direction * (toMillis(a.mtime) - toMillis(b.mtime));
    return direction * a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  };
  return [...entries].sort(compare);
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

export const isDenied = (message: string): boolean =>
  /denied|EACCES|EPERM|not permitted|forbidden/i.test(message);
