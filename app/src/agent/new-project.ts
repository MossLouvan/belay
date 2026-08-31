// Pure logic behind the "New project" sheet: name validation, the parent-
// folder suggestions, the path preview, and the error mapping. No React and
// no JSX, so `new-project.test.mjs` can import it straight into Node.
//
// The server validates everything again, but a phone keyboard makes rubbish
// easy to type ("my/app", a name pasted with a newline) and a round-trip to
// the PC is a slow way to learn a rule — so the obvious cases are rejected
// here, with the rule spelled out.

import type { AgentProject } from '../api';

/**
 * Longer than any sane folder name, shorter than anything that could push a
 * full path past a filesystem's limit once the parent is prepended.
 */
export const MAX_NAME_LENGTH = 64;

/**
 * Characters Windows refuses in a file name. The Mac host would accept most
 * of them, but a project that cannot be checked out on a teammate's Windows
 * machine is a trap better refused on both platforms.
 */
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Device names Windows reserves regardless of extension or case. Creating
 * "con" succeeds on a Mac and then wedges every Windows tool that touches it.
 */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export type NameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a project name typed by the user. Returns the trimmed name on
 * success, or the rule that was broken — phrased for the person holding the
 * phone, not for a log file.
 */
export function validateProjectName(raw: string): NameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, reason: 'Type a name for the project.' };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `Keep the name under ${MAX_NAME_LENGTH} characters.` };
  }
  if (/[\\/]/.test(name)) {
    return { ok: false, reason: 'A name cannot contain / or \\ — pick the parent folder below instead.' };
  }
  if (name.includes('..')) {
    return { ok: false, reason: 'A name cannot contain "..".' };
  }
  if (name.startsWith('.')) {
    return { ok: false, reason: 'A name cannot start with a dot — hidden folders would vanish from file browsers.' };
  }
  if (/[. ]$/.test(name)) {
    return { ok: false, reason: 'A name cannot end with a dot or a space.' };
  }
  if (FORBIDDEN_CHARS.test(name)) {
    return { ok: false, reason: 'A name cannot contain < > : " | ? * or control characters.' };
  }
  if (RESERVED_WINDOWS_NAMES.test(name)) {
    return { ok: false, reason: `"${name}" is a reserved name on Windows — pick another.` };
  }
  return { ok: true, name };
}

/** True when the parent path looks like a Windows one, so joins match it. */
const isWindowsPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.includes('\\');

/**
 * The path that will be created, shown before it is. Joins with the parent's
 * own separator style so the preview matches what the PC will actually make —
 * "C:\Users\me/app" on screen would rightly make anyone hesitate.
 */
export function previewPath(parent: string, name: string): string {
  const sep = isWindowsPath(parent) ? '\\' : '/';
  const base = parent.replace(/[\\/]+$/, '');
  return `${base || sep}${sep}${name}`;
}

/** The folder a path lives in, in that path's own separator style. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut <= 0) return trimmed || path;
  // "C:\x" must give "C:\", not "C:" — a bare drive letter is the current
  // directory on that drive, which is not a place to create anything.
  const head = trimmed.slice(0, cut);
  return /^[a-z]:$/i.test(head) ? head + '\\' : head;
}

/**
 * Where a new project should probably live, learned from where the existing
 * ones do. The folder that holds the most known projects goes first, so the
 * default is "next to everything else" rather than a guess at a convention
 * this PC may not follow. `~` is the fallback when nothing is known — the
 * host resolves it to the home folder.
 */
export function suggestParents(projects: readonly AgentProject[]): readonly string[] {
  const counts = new Map<string, { parent: string; count: number; order: number }>();
  for (const [order, p] of projects.entries()) {
    const parent = parentOf(p.path);
    if (parent === p.path) continue;
    const key = parent.toLowerCase();
    const seen = counts.get(key);
    if (seen) counts.set(key, { ...seen, count: seen.count + 1 });
    else counts.set(key, { parent, count: 1, order });
  }
  const ranked = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((c) => c.parent)
    .slice(0, 3);
  return ranked.length > 0 ? ranked : ['~'];
}

/**
 * Turn a create failure into advice. The interesting case is a 404: an older
 * host that predates POST /agent/projects has no body with an `error` field,
 * so the generic "request failed (404)" surfaces — which reads like the app
 * is broken when really the host just needs an update.
 */
export function mapCreateError(message: string): string {
  if (/\(404\)/.test(message)) {
    return 'This computer\'s Tether host is too old to create folders. Update it there, or make the folder on the PC and pick it from the list.';
  }
  return message;
}
