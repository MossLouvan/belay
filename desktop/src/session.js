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
const EMPTY = { host: '', token: '', label: '', platform: '', keymap: 'remap' };

/**
 * The keyboard modifier mode (see src/modmap.js). Two values only, and any
 * junk in the file resolves to the default rather than to an unmapped
 * keyboard nobody chose.
 */
export function keymapModeOf(value) {
  return value === 'verbatim' ? 'verbatim' : 'remap';
}

export function sessionPath(userDataDir) {
  return join(userDataDir, 'session.json');
}

/**
 * Copy the session saved before the rename to Belay, once.
 *
 * Electron derives the userData directory from the package name, so renaming
 * tether-desktop → belay-desktop silently pointed the client at a fresh,
 * empty directory — and "empty session" renders as "not paired", making the
 * rename cost the owner a re-pair for no reason. The old file is copied, not
 * moved: an old build may still be on this machine and pointed at it, and a
 * saved token is the last thing to delete speculatively.
 */
export function migrateLegacySession(userDataDir, legacyUserDataDir) {
  try {
    const current = sessionPath(userDataDir);
    let hasCurrent = true;
    try { readFileSync(current); } catch { hasCurrent = false; }
    if (hasCurrent) return false;
    const legacy = readSession(legacyUserDataDir);
    if (!legacy.host && !legacy.token) return false;
    writeSession(userDataDir, legacy);
    return true;
  } catch {
    return false; // worst case is the pairing screen, which always works
  }
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
      // The host's platform, remembered so a display window knows which
      // modifier map to build before the host has answered anything.
      platform: typeof parsed.platform === 'string' ? parsed.platform : '',
      keymap: keymapModeOf(parsed.keymap),
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
