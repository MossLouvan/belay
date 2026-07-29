// A confined file browser. Listing and reading are limited to an allow-list of
// roots (the user's home by default) and every path is resolved and re-checked
// against those roots, so `..` traversal cannot escape.

import { readdir, stat, readFile } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

// Roots the app is allowed to browse. Home covers the normal dev use case;
// drive roots are handy for jumping to projects elsewhere.
export const ROOTS: { name: string; path: string }[] = [
  { name: 'Home', path: HOME },
  { name: 'Desktop', path: join(HOME, 'Desktop') },
  { name: 'Documents', path: join(HOME, 'Documents') },
  { name: 'Downloads', path: join(HOME, 'Downloads') },
];

function allowed(target: string): boolean {
  const t = resolve(target);
  return ROOTS.some((r) => {
    const root = resolve(r.path);
    return t === root || t.startsWith(root + sep);
  });
}

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export async function listDir(target: string): Promise<{ path: string; entries: Entry[] }> {
  const dir = resolve(target || HOME);
  if (!allowed(dir)) throw new Error('path is outside the allowed roots');
  const names = await readdir(dir);
  const entries: Entry[] = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const s = await stat(full);
      entries.push({
        name,
        path: full,
        dir: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      });
    } catch {
      // Unreadable entries (permissions, locked files) are simply skipped.
    }
  }
  // Folders first, then alphabetical — the order people expect in a file list.
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: dir, entries };
}

const MAX_READ = 512 * 1024; // 512 KB cap; this is a viewer, not a download tool.

export async function readTextFile(target: string): Promise<{ path: string; name: string; content: string; truncated: boolean; size: number }> {
  const file = resolve(target);
  if (!allowed(file)) throw new Error('path is outside the allowed roots');
  const s = await stat(file);
  if (s.isDirectory()) throw new Error('path is a directory');
  const buf = await readFile(file);
  const truncated = buf.length > MAX_READ;
  const slice = truncated ? buf.subarray(0, MAX_READ) : buf;
  return {
    path: file,
    name: basename(file),
    content: slice.toString('utf8'),
    truncated,
    size: s.size,
  };
}
