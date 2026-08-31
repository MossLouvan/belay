// A confined, read-only file browser. Listing and reading are limited to an
// allow-list of roots (the user's home by default).
//
// Confinement is enforced on *real* paths, not lexical ones. `path.resolve`
// collapses `..` but knows nothing about symlinks, and a macOS home directory
// (or /tmp, or /Volumes) is full of them — a single `ln -s /etc ~/x` would
// otherwise expose the whole filesystem through an "allowed" path. Every path
// is therefore passed through `fs.realpath` before the prefix check, and the
// roots themselves are realpath'd too so the comparison is like-for-like.
//
// Threat model and residual window. What this guarantees is that no path the
// caller supplies can escape the roots *via symlinks*: confinement is decided
// on the fully resolved path, not the lexical one. What it does not eliminate
// is the check-then-use window inherent to a path-based API — the resolved path
// is validated and then the same path *string* is reopened by readdir/readFile/
// stat, so in principle a symlink could be swapped in between. Exploiting that
// requires an attacker who can already write to that exact path on this
// machine, i.e. someone with local filesystem access who could simply read the
// file directly; the window itself is sub-millisecond and dominated by network
// round-trip time. Against Tether's threat model (a remote client on the LAN or
// a Tailnet, with the local user trusted) that residual risk is accepted rather
// than paid for with an fd-based rewrite of the whole file API.

import { readdir, stat, lstat, readFile, realpath } from 'node:fs/promises';
import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, join, sep, basename } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

const MAX_READ = 512 * 1024; // 512 KB cap; this is a viewer, not a download tool.

// macOS mounts external and network drives under /Volumes. It also contains a
// symlink to `/` ("Macintosh HD"); that is harmless because the guard below
// resolves symlinks before checking, so it simply reads as outside the roots.
const DARWIN_VOLUMES = '/Volumes';

export interface Root {
  readonly name: string;
  readonly path: string;
}

function candidateRoots(): Root[] {
  const common: Root[] = [
    { name: 'Home', path: HOME },
    { name: 'Desktop', path: join(HOME, 'Desktop') },
    { name: 'Documents', path: join(HOME, 'Documents') },
    { name: 'Downloads', path: join(HOME, 'Downloads') },
  ];
  if (process.platform !== 'darwin') return common;
  return [...common, { name: 'Volumes', path: DARWIN_VOLUMES }];
}

function isExistingDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Roots the app is allowed to browse. Anything that does not exist is dropped
// so the app never offers a shortcut that errors when tapped; Home is always
// kept so the list can never be empty.
export const ROOTS: readonly Root[] = candidateRoots().filter(
  (r) => r.path === HOME || isExistingDir(r.path),
);

/**
 * The real (symlink-free) form of each root, computed once at startup.
 * If a root cannot be resolved we fall back to its lexical form rather than
 * dropping it, which keeps the allow-list conservative either way.
 *
 * `realpathSync.native` — not plain `realpathSync` — on purpose: see the note
 * on `isInsideRoots` below.
 */
const REAL_ROOTS: readonly string[] = ROOTS.map((r) => {
  try {
    return realpathSync.native(r.path);
  } catch {
    return resolve(r.path);
  }
});

/**
 * True when `realTarget` (already symlink-free) is a root or lives inside one.
 *
 * The comparison is case-SENSITIVE, and that is only safe because both sides
 * are canonicalised the same way. APFS and NTFS are case-insensitive by
 * default, so `~/documents` and `~/Documents` name the same directory; if the
 * roots were canonicalised differently from the user paths, a wrong-case
 * request could fail the prefix check (breaking legitimate access) or, worse,
 * a wrong-case *root* prefix could be sidestepped.
 *
 * Both sides therefore go through the OS's own realpath, which normalises case
 * to the on-disk form: user paths via `fs.promises.realpath` and the roots via
 * `fs.realpathSync.native`. Do NOT swap either for the legacy JS
 * `fs.realpathSync` (or any lexical `resolve()`-only path) — it resolves
 * symlinks but does *not* canonicalise case, which would silently reintroduce a
 * case-based prefix-check bypass. `test/files.test.ts` covers this.
 */
/**
 * Places that sit inside a root but must never be served, because reading them
 * is worth more to an attacker than the rest of the home folder put together:
 *
 *   - the Tether install directory itself — `tether-state.json` there holds the
 *     raw bearer token of every paired device, so one paired phone could read
 *     it and impersonate all the others (and survive its own revocation);
 *   - credential folders and files (`~/.ssh`, `~/.aws`, `~/.claude`, shell
 *     history, `.netrc`, ...).
 *
 * Compared case-insensitively: both APFS and NTFS are case-insensitive by
 * default and this list is a deny-list, so erring towards "denied" is the
 * safe direction.
 */
const DENIED_DIRS: readonly string[] = [
  process.cwd(),
  ...[
    '.ssh', '.aws', '.gnupg', '.claude', '.claude.json', '.azure', '.kube', '.docker', '.config',
    '.gitconfig', '.npmrc', '.netrc', '.bash_history', '.zsh_history', '.python_history',
    'AppData/Local/Google/Chrome/User Data', 'AppData/Roaming/Mozilla',
    'Library/Keychains', 'Library/Application Support/Google/Chrome',
  ].map((d) => join(HOME, d)),
].map((p) => {
  try { return realpathSync.native(p); } catch { return resolve(p); }
});

const DENIED_FILE = /^tether-(state|agent)\.json$/i;

export function isDenied(realTarget: string, denied: readonly string[] = DENIED_DIRS): boolean {
  const target = resolve(realTarget);
  const lower = target.toLowerCase();
  if (denied.some((d) => {
    const dl = resolve(d).toLowerCase();
    return lower === dl || lower.startsWith(dl + sep);
  })) return true;
  const segments = target.split(sep);
  return DENIED_FILE.test(segments[segments.length - 1] ?? '');
}

export function isInsideRoots(realTarget: string, roots: readonly string[] = REAL_ROOTS): boolean {
  const target = resolve(realTarget);
  return roots.some((root) => {
    const r = resolve(root);
    return target === r || target.startsWith(r + sep);
  });
}

/**
 * Resolve a caller-supplied path to its real location and assert it is inside
 * the allow-list. Throws with a user-safe message on anything else.
 *
 * Exported so files-raw.ts (the binary preview path) goes through the exact
 * same confinement — two hand-maintained copies of a security check is how one
 * of them quietly falls behind.
 */
export async function resolveInsideRoots(target: string): Promise<string> {
  const lexical = resolve(target);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new Error('path does not exist');
    if (code === 'EACCES' || code === 'EPERM') throw new Error('path is not readable');
    throw new Error('path could not be resolved');
  }
  if (!isInsideRoots(real)) throw new Error('path is outside the allowed roots');
  if (isDenied(real)) throw new Error('path is outside the allowed roots');
  return real;
}

export interface Entry {
  readonly name: string;
  readonly path: string;
  readonly dir: boolean;
  readonly size: number;
  readonly mtime: number;
  /** True when the entry is a symlink that points somewhere inside the roots. */
  readonly link: boolean;
}

/**
 * Describe one directory entry, or null if it should not be shown.
 *
 * Symlinks are resolved and checked against the allow-list: one pointing
 * outside is omitted entirely rather than listed with its target's metadata,
 * so the listing cannot leak anything about files beyond the roots.
 */
async function describeEntry(dir: string, name: string): Promise<Entry | null> {
  const full = join(dir, name);
  if (isDenied(full)) return null;
  try {
    const link = await lstat(full);
    if (!link.isSymbolicLink()) {
      return {
        name,
        path: full,
        dir: link.isDirectory(),
        size: link.size,
        mtime: link.mtimeMs,
        link: false,
      };
    }
    const real = await realpath(full);
    if (!isInsideRoots(real) || isDenied(real)) return null;
    const s = await stat(full);
    return { name, path: full, dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs, link: true };
  } catch {
    // Unreadable entries (permissions, broken symlinks) are simply skipped.
    return null;
  }
}

export async function listDir(target: string): Promise<{ path: string; entries: Entry[] }> {
  const dir = await resolveInsideRoots(target || HOME);
  // The Files tab accepts hand-typed paths, so its three failure modes must
  // stay distinguishable: "outside the roots" and "does not exist" are thrown
  // above, and pointing at a file must say so rather than leak the raw
  // ENOTDIR (whose message embeds the scandir syscall and full path).
  const s = await stat(dir);
  if (!s.isDirectory()) throw new Error('path is a file, not a folder');
  const names = await readdir(dir);
  const described = await Promise.all(names.map((name) => describeEntry(dir, name)));
  const entries = described.filter((e): e is Entry => e !== null);
  // Folders first, then alphabetical — the order people expect in a file list.
  const sorted = [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: dir, entries: sorted };
}

export interface TextFile {
  readonly path: string;
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly size: number;
}

export async function readTextFile(target: string): Promise<TextFile> {
  const file = await resolveInsideRoots(target);
  const s = await stat(file);
  if (s.isDirectory()) throw new Error('path is a directory');
  if (!s.isFile()) throw new Error('path is not a regular file');
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
