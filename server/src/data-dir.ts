// Where the host keeps its state file, TLS key and certificate.
//
// `npx belay-host` runs from whatever directory the user happens to be in, so
// "beside the process" is no longer a stable place: every start from a new
// folder would be a fresh, unpaired host. New installs therefore use the
// platform's per-user data directory. Existing installs keep exactly what they
// had — an explicit BELAY_STATE_FILE (the LaunchAgent pins one) or a state
// file already sitting in the working directory wins, so nothing is unpaired
// by an upgrade. Pure, so every rule is testable without touching the disk.

import { join } from 'node:path';

export const STATE_FILE_NAME = 'belay-state.json';
/** Pre-rename state file; state.ts still reads it from the same directory. */
export const LEGACY_STATE_FILE_NAME = 'tether-state.json';

export interface DataDirEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Record<string, string | undefined>;
}

/** The per-user data directory for this platform. */
export function dataDir({ platform, home, env }: DataDirEnv): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Belay');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Belay');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'belay');
}

/**
 * The state file this process should use.
 *
 * 1. `configured` (BELAY_STATE_FILE / TETHER_STATE_FILE) — exactly that file.
 * 2. A `belay-state.json` or `tether-state.json` already in `cwd` — the
 *    pre-data-dir location; keep using it so nobody has to pair again.
 * 3. Otherwise the per-user data directory.
 */
export function resolveStateFile(
  configured: string | undefined,
  cwd: string,
  where: DataDirEnv,
  exists: (path: string) => boolean,
): string {
  if (configured) return configured;
  const inCwd = join(cwd, STATE_FILE_NAME);
  if (exists(inCwd) || exists(join(cwd, LEGACY_STATE_FILE_NAME))) return inCwd;
  return join(dataDir(where), STATE_FILE_NAME);
}
