// Read-only "what changed" for a session's project folder: the git working
// tree, gathered for the phone and summarised in plain English.
//
// This is the third surface that stands next to a write path (after
// projects.ts and the session cwd), so it takes the same confinement as both:
// the folder goes through fs.realpath and the files.ts allow/deny lists
// before git ever sees it. The session cwd was confined when the session was
// created, but sessions persist across restarts and the deny-list can change
// between versions — re-checking here costs one realpath and removes the
// assumption entirely.
//
// Read-only is enforced by construction, not convention: every git invocation
// below goes through execFile with a fixed argv — no shell, no interpolation,
// and no subcommand that writes (`status`, `diff`, `rev-parse` only; `diff
// --no-index` compares without touching the index despite the scary name).
// The one caller-influenced value, the folder, is passed as execFile's `cwd`
// option, never as an argument string.

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { isInsideRoots, isDenied } from './files.js';
import { summarizeChanges } from './changes-summary.js';
import type { ChangedFile, ChangeSummary } from './changes-summary.js';

const execFileAsync = promisify(execFile);

/**
 * Ceiling on the diff text sent to the phone. 200 KB is ~5000 diff lines —
 * far past what anyone reviews on a phone — and keeps the JSON response
 * comfortably under every transport limit. The response says when it was cut.
 */
export const DIFF_CAP = 200 * 1024;

// git's own stdout ceiling per invocation, above the cap so truncation is
// detected by us (with an honest flag) rather than surfacing as an execFile
// ENOBUFS error the route would report as a failure.
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * How many brand-new files get real line counts and inline diffs. Each one
 * costs a git invocation (`diff --no-index` against /dev/null), so a folder
 * with hundreds of untracked files — a fresh node_modules would be the
 * classic case, though git usually ignores it — stays cheap; files past the
 * cap still appear in the list, just without counts.
 */
const MAX_NEW_FILE_DIFFS = 20;

export interface ProjectChanges {
  /** False when the folder has no git history to compare against. */
  readonly repo: boolean;
  readonly clean: boolean;
  readonly summary: ChangeSummary;
  readonly files: readonly ChangedFile[];
  readonly diff: string;
  readonly diffTruncated: boolean;
}

/** Same message shape as projects.ts: denied and outside are indistinguishable. */
async function confine(cwd: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(resolve(cwd));
  } catch {
    throw new Error('that project folder no longer exists');
  }
  if (!isInsideRoots(real) || isDenied(real)) {
    throw new Error('that folder is outside the allowed folders');
  }
  return real;
}

/** Run git read-only in `dir`. Throws execFile's error on non-zero exit. */
async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: dir,
    maxBuffer: GIT_MAX_BUFFER,
    // Untranslated, unpaged, and with literal (unquoted) non-ASCII paths, so
    // the parsers below see one stable format regardless of host config.
    env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat' },
  });
  return stdout;
}

/** One entry of `git status --porcelain=v1 -z`, classified for the phone. */
interface StatusEntry {
  readonly path: string;
  readonly kind: ChangedFile['kind'];
  readonly from?: string;
}

/**
 * Parse NUL-delimited porcelain status. -z is not a nicety: it is the only
 * porcelain form where a path with a quote, a space or a newline arrives
 * literally instead of C-escaped, and a rename's origin follows the entry as
 * its own NUL-separated token.
 */
export function parseStatus(raw: string): StatusEntry[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.length < 4) continue; // "XY <path>" is at least 4 chars
    const x = token[0]!;
    const y = token[1]!;
    const path = token.slice(3);
    if (x === 'R' || x === 'C') {
      // The next token is the source path the file was renamed/copied from.
      const from = tokens[i + 1];
      i += 1;
      entries.push({ path, kind: 'renamed', from });
      continue;
    }
    const kind: ChangedFile['kind'] =
      x === '?' ? 'new'
      : x === 'A' || y === 'A' ? 'new'
      : x === 'D' || y === 'D' ? 'deleted'
      : 'edited';
    entries.push({ path, kind });
  }
  return entries;
}

/**
 * Parse NUL-delimited `--numstat -z` into per-path line counts. Binary files
 * report "-" for both counts; renames put an empty path in the record and
 * follow it with source and destination tokens (counts belong to the
 * destination).
 */
export function parseNumstat(raw: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    let path = m[3]!;
    if (path === '') {
      // Rename record: "<added>\t<removed>\t\0<from>\0<to>". Skip the source,
      // attribute the counts to where the file lives now.
      path = tokens[i + 2] ?? '';
      i += 2;
    }
    if (path) counts.set(path, { added, removed });
  }
  return counts;
}

/**
 * Line counts and a diff for one brand-new file, via `git diff --no-index`
 * against /dev/null. Read-only despite touching no commit: --no-index
 * compares two paths on disk and writes nothing. Exit code 1 just means "the
 * files differ", which here is the expected outcome, not an error.
 */
async function describeNewFile(dir: string, path: string): Promise<{
  added: number | null; removed: number | null; binary: boolean; diff: string;
}> {
  // git's own spelling of "the empty file" on each platform.
  const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const run = async (args: readonly string[]): Promise<string> => {
    try {
      return await git(dir, args);
    } catch (error: unknown) {
      const failed = error as { code?: number; stdout?: string };
      if (failed.code === 1 && typeof failed.stdout === 'string') return failed.stdout;
      throw error;
    }
  };
  const numstat = await run(['diff', '--no-index', '--numstat', '-z', '--', empty, path]);
  const counts = parseNumstat(numstat);
  const entry = [...counts.values()][0] ?? { added: null, removed: null };
  const binary = entry.added === null;
  const diff = binary ? '' : await run(['diff', '--no-index', '--', empty, path]);
  return { ...entry, binary, diff };
}

/** Cut the diff at the cap, on a line boundary, so no half-line renders. */
export function capDiff(diff: string, cap: number = DIFF_CAP): { text: string; truncated: boolean } {
  if (diff.length <= cap) return { text: diff, truncated: false };
  const cut = diff.lastIndexOf('\n', cap);
  return { text: diff.slice(0, cut > 0 ? cut + 1 : cap), truncated: true };
}

const CLEAN: Omit<ProjectChanges, 'repo' | 'summary'> = {
  clean: true, files: [], diff: '', diffTruncated: false,
};

/**
 * Everything the phone's "what changed" screen needs, in one read-only pass.
 *
 * Compares against HEAD — the last commit — not the index, because "what did
 * Claude do" includes anything it staged. A repo with no commits yet is
 * served too: every file is simply new.
 */
export async function collectChanges(cwd: string): Promise<ProjectChanges> {
  const dir = await confine(cwd);

  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('git is not installed on this computer');
    }
    return {
      ...CLEAN, repo: false, clean: false,
      summary: {
        headline: 'This folder doesn’t keep change history, so there’s no record of what changed.',
        cautions: [],
      },
    };
  }

  const hasHead = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    .then(() => true).catch(() => false);

  const status = parseStatus(await git(dir, ['status', '--porcelain=v1', '-z']));
  if (status.length === 0) {
    return { ...CLEAN, repo: true, summary: summarizeChanges([]) };
  }

  // Tracked changes: counts and the diff come from one comparison each.
  const counts = hasHead
    ? parseNumstat(await git(dir, ['diff', 'HEAD', '--numstat', '-z', '--find-renames']))
    : new Map<string, { added: number | null; removed: number | null }>();
  let diff = hasHead ? await git(dir, ['diff', 'HEAD', '--find-renames']) : '';

  const files: ChangedFile[] = [];
  let newFilesDescribed = 0;
  for (const entry of status) {
    const tracked = counts.get(entry.path);
    if (entry.kind === 'new' && !tracked && newFilesDescribed < MAX_NEW_FILE_DIFFS) {
      // Untracked: invisible to `diff HEAD`, so it gets its own comparison.
      newFilesDescribed += 1;
      try {
        const described = await describeNewFile(dir, entry.path);
        diff += described.diff;
        files.push({ path: entry.path, kind: 'new', added: described.added, removed: described.removed, binary: described.binary });
        continue;
      } catch {
        // Unreadable (permissions, vanished mid-scan): list it without counts.
      }
    }
    files.push({
      path: entry.path,
      kind: entry.kind,
      ...(entry.from ? { from: entry.from } : {}),
      added: tracked?.added ?? null,
      removed: tracked?.removed ?? null,
      binary: tracked ? tracked.added === null : false,
    });
  }

  const capped = capDiff(diff);
  return {
    repo: true,
    clean: false,
    summary: summarizeChanges(files),
    files,
    diff: capped.text,
    diffTruncated: capped.truncated,
  };
}
