// The one-line "what changed" a done notice carries: `git diff HEAD
// --shortstat` plus the untracked-file count, in the session's cwd. Read-only
// by construction, the way changes.ts is: execFile with a fixed argv, the
// folder passed only as `cwd`, never as an argument, a short timeout, and any
// failure (not a repo, no git, no HEAD, timed out) is `undefined` — the
// notice simply has no stat rather than a wrong one.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Under the hook script's 3 s wait for a Stop, so the notice still lands.
const GIT_TIMEOUT_MS = 2_000;

export interface ChangeStat {
  /** Changed tracked files plus untracked ones. */
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly cwd: string;
}

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 })).stdout;

/** " 3 files changed, 41 insertions(+), 7 deletions(-)" → numbers; empty → zeros. */
export function parseShortstat(line: string): Omit<ChangeStat, 'cwd'> {
  const n = (re: RegExp): number => Number(re.exec(line)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}

export async function changeStat(cwd: string): Promise<ChangeStat | undefined> {
  try {
    const [stat, untracked] = await Promise.all([
      git(cwd, ['diff', 'HEAD', '--shortstat']),
      git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const parsed = parseShortstat(stat);
    const extra = untracked.split('\0').filter(Boolean).length;
    return { ...parsed, files: parsed.files + extra, cwd };
  } catch {
    return undefined;
  }
}
