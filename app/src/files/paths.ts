// Parsing and validation for the "Go to Folder" box — Deskhandler's version of
// Finder's ⇧⌘G. People paste paths from everywhere: Finder's "Copy as
// Pathname", a terminal (which backslash-escapes spaces), a chat message that
// wrapped the path in quotes, a `file://` URL. All of those should just work,
// so the cleaner strips that decoration before anything is judged.
//
// Validation here is a courtesy, not the security boundary: the host re-checks
// every path against its realpath'd allow-list (server/src/files.ts). Checking
// on the phone first means a path that could never succeed gets an instant,
// specific message instead of a round-trip and a generic refusal.

export interface RootLike {
  readonly name: string;
  readonly path: string;
}

export type GoToVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path);

const isAbsolute = (path: string): boolean => path.startsWith('/') || isWindowsPath(path);

/**
 * Undo the decoration a pasted path tends to arrive with. Order matters:
 * quotes come off before escape-unwrapping, or a quoted terminal path keeps
 * its backslashes; the file:// prefix is percent-decoded because Finder
 * URL-encodes spaces as %20.
 */
export function cleanPathInput(raw: string): string {
  let path = raw.trim();
  const quoted =
    (path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"));
  if (quoted && path.length >= 2) path = path.slice(1, -1).trim();
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\/(localhost)?/i, '');
    try {
      path = decodeURIComponent(path);
    } catch {
      // Malformed percent-encoding: keep the raw text and let validation speak.
    }
  }
  // Terminal drag-and-drop escapes spaces and parens; the filesystem wants
  // them plain. Only meaningful on POSIX paths — on Windows the backslash IS
  // the separator, so unescaping would eat it.
  if (!isWindowsPath(path)) path = path.replace(/\\([ ()'"&])/g, '$1');
  return collapseSeparators(path);
}

/** Doubled separators and trailing ones are noise; the root itself keeps its one. */
function collapseSeparators(path: string): string {
  if (isWindowsPath(path)) {
    const collapsed = path.replace(/[\\/]+/g, '\\');
    return collapsed.length > 3 ? collapsed.replace(/\\+$/, '') : collapsed;
  }
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/** `~` means the host's home, which is always the root the host names "Home". */
export function expandTilde(path: string, roots: readonly RootLike[]): string {
  if (path !== '~' && !path.startsWith('~/')) return path;
  const home = roots.find((r) => r.name === 'Home') ?? roots[0];
  if (!home) return path;
  return path === '~' ? home.path : home.path + path.slice(1);
}

/**
 * True when `path` is a root or sits under one. Case-insensitive on purpose:
 * APFS and NTFS both are by default, so `/users/moss` and `/Users/moss` name
 * the same folder and refusing the former would be a lie. The boundary check
 * (`root + separator`) stops `/UsersEvil` from matching a `/Users` root.
 */
export function isUnderRoot(path: string, roots: readonly RootLike[]): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase();
  const target = norm(path);
  return roots.some((root) => {
    const r = norm(root.path);
    return target === r || target.startsWith(r.endsWith('/') ? r : r + '/');
  });
}

/**
 * The full pipeline for the Go box. Every failure names its fix, because "path
 * not allowed" on its own leaves the user guessing whether they typo'd, forgot
 * the leading slash, or asked for somewhere genuinely off-limits.
 */
export function parseGoTo(raw: string, roots: readonly RootLike[]): GoToVerdict {
  const cleaned = expandTilde(cleanPathInput(raw), roots);
  if (!cleaned) return { ok: false, reason: 'Type or paste a folder path first.' };
  if (!isAbsolute(cleaned)) {
    return {
      ok: false,
      reason: 'That is not a full path. Start from the top: / on Mac, or a drive like C:\\ on Windows.',
    };
  }
  if (roots.length > 0 && !isUnderRoot(cleaned, roots)) {
    const names = roots.map((r) => r.name).join(', ');
    return {
      ok: false,
      reason: `That path is outside the folders this phone may browse (${names}).`,
    };
  }
  return { ok: true, path: cleaned };
}
