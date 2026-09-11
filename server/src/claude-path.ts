// Where the `claude` binary might be when PATH does not say.
//
// `which`/`where` is right for a host started from a terminal — but Belay
// also runs as a launchd/Task Scheduler service, whose PATH is the bare
// system default. The native installer puts claude in ~/.local/bin, the npm
// global on Windows lands in %APPDATA%\npm, Homebrew in /opt/homebrew/bin:
// none of those are on a service's PATH, so "claude not found" was the boot
// banner on exactly the machines meant to run unattended. Pure so the order
// and the platform split are testable without a filesystem.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Well-known install locations, most specific first. Every candidate is a
 * full path to try with existsSync; the caller picks the first that exists.
 * PATH lookup happens before any of these — a user who deliberately put a
 * different claude on PATH wins.
 */
export function claudeCandidates({ platform, home, env }: PathEnv): readonly string[] {
  const win = platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const out: string[] = [
    // The native installer, both platforms.
    join(home, '.local', 'bin', exe),
    // Claude Code's own "local" install (`claude migrate-installer`).
    join(home, '.claude', 'local', exe),
  ];
  if (win) {
    if (env.APPDATA) out.push(join(env.APPDATA, 'npm', 'claude.cmd'));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  } else {
    out.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  }
  return out;
}

/**
 * The first candidate that exists, or null. `exists` is injected so the
 * probe order is testable; production passes fs.existsSync.
 */
export function pickClaude(
  candidates: readonly string[],
  exists: (path: string) => boolean,
): string | null {
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch { /* unreadable — not it */ }
  }
  return null;
}

// ---- the resolved binary ---------------------------------------------------

/**
 * PATH first (`which`/`where`), then the well-known install locations above.
 * The PATH answer wins so a deliberately chosen binary is respected; the
 * fallbacks exist for hosts started as a service, whose PATH is the bare
 * system default and knows nothing about ~/.local/bin or Homebrew.
 *
 * Looked up once per process and memoised — the boot banner prints whichever
 * was chosen. Lives here rather than in agent.ts so both session kinds (the
 * stream-json child and the pty-backed interactive one) resolve the binary
 * through exactly one door, with no import cycle between them.
 */
export function findClaude(): string | null {
  if (claudePath !== undefined) return claudePath;
  claudePath = claudeOnPath() ?? pickClaude(
    claudeCandidates({ platform: process.platform, home: homedir(), env: process.env }),
    existsSync,
  );
  return claudePath;
}

let claudePath: string | null | undefined; // undefined = not looked up yet

function claudeOnPath(): string | null {
  const probe = process.platform === 'win32' ? ['where.exe', ['claude']] as const : ['which', ['claude']] as const;
  try {
    const out = execFileSync(probe[0], probe[1] as unknown as string[], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch { return null; }
}
