// Where the desktop client keeps the host address and bearer token between
// runs. Main-process only: the renderer reaches it through IPC and never sees
// the file path, so a compromised page cannot read or rewrite it directly.
//
// Stored under Electron's userData directory rather than in localStorage
// because a bearer token grants full control of the paired computer — mouse,
// keyboard, files, shell. localStorage is readable by anything that manages to
// run script in the renderer; this file is written owner-only (0600), matching
// how the host itself stores its own state (server/src/state.ts).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Shape persisted to disk. Anything else in the file is ignored on read. */
const EMPTY = { host: '', token: '', label: '' };

export function sessionPath(userDataDir) {
  return join(userDataDir, 'session.json');
}

/**
 * Read the saved session, or the empty one.
 *
 * Every failure — no file yet, unreadable, corrupt JSON, a JSON array where an
 * object belongs — resolves to "not paired" rather than throwing. The client's
 * response to that is to show the pairing screen, which is exactly the right
 * thing to do with a session it cannot make sense of.
 */
export function readSession(userDataDir) {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(userDataDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...EMPTY };
    return {
      host: typeof parsed.host === 'string' ? parsed.host : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
      label: typeof parsed.label === 'string' ? parsed.label : '',
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Persist a session, owner-readable only.
 *
 * The chmod is separate from the write and deliberately not fatal: on Windows
 * the POSIX mode is largely advisory, and refusing to remember a session
 * because a permission bit could not be set would break the client on the
 * platform where the bit does not mean much anyway.
 */
export function writeSession(userDataDir, session) {
  const file = sessionPath(userDataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...EMPTY, ...session }, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort; see above */ }
}

export function clearSession(userDataDir) {
  writeSession(userDataDir, EMPTY);
}
