// Where the desktop client keeps the host address and bearer token between
// runs. Main-process only: the renderer reaches it through IPC and never sees
// the file path, so a compromised page cannot read or rewrite it directly.
//
// Stored under Electron's userData directory rather than in localStorage
// because a bearer token grants full control of the paired computer — mouse,
// keyboard, files, shell. localStorage is readable by anything that manages to
// run script in the renderer; this file is written owner-only (0600), matching
// how the host itself stores its own state (server/src/state.ts).
//
// On top of that the token itself is encrypted at rest with Electron's
// safeStorage (Keychain / DPAPI / libsecret), passed in from main.js as
// `vault`, so a copied session.json is useless on another account or machine.
// It is stored as `tokenEnc` (base64); a plaintext `token` from an older build
// is re-sealed the first time it is read. Where safeStorage is unavailable
// (some Linux setups without a keyring) the token stays plaintext, with a
// warning: an unencrypted 0600 file beats a client that forgets its pairing.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Shape persisted to disk. Anything else in the file is ignored on read. */
const EMPTY = { host: '', token: '', label: '', platform: '', keymap: 'remap', fingerprint: '', deviceId: '', secret: '' };

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

/** True when `vault` (Electron's safeStorage shape) can encrypt right now. */
function canSeal(vault) {
  if (!vault) return false;
  try {
    if (vault.isEncryptionAvailable()) return true;
  } catch (error) {
    console.warn('[belay] safeStorage check failed:', error);
  }
  console.warn('[belay] safeStorage unavailable; the device token is stored unencrypted (file is still 0600)');
  return false;
}

/**
 * The fields to persist for one credential: `<name>Enc` when it can be
 * sealed, else the plaintext under `name`. The token and the host-proof
 * secret (src/proof.js) are both credentials and get the same treatment.
 */
function seal(name, value, vault) {
  if (!value || !canSeal(vault)) return { [name]: value };
  try {
    return { [name]: '', [`${name}Enc`]: vault.encryptString(value).toString('base64') };
  } catch (error) {
    console.warn(`[belay] safeStorage encrypt failed; storing the ${name} unencrypted:`, error);
    return { [name]: value };
  }
}

/** The plaintext credential from a parsed file, or '' when it cannot be opened. */
function open(name, parsed, vault) {
  const sealed = parsed[`${name}Enc`];
  if (typeof sealed === 'string' && sealed) {
    try {
      return vault.decryptString(Buffer.from(sealed, 'base64'));
    } catch (error) {
      // A value sealed by another OS account or a lost keychain entry cannot
      // be recovered; the pairing screen is the only way forward.
      console.warn(`[belay] could not decrypt the saved device ${name}:`, error);
      return '';
    }
  }
  return typeof parsed[name] === 'string' ? parsed[name] : '';
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
export function migrateLegacySession(userDataDir, legacyUserDataDir, vault) {
  try {
    const current = sessionPath(userDataDir);
    let hasCurrent = true;
    try { readFileSync(current); } catch { hasCurrent = false; }
    if (hasCurrent) return false;
    // Parsed without migrating: the legacy file belongs to the old build.
    const { session: legacy } = parseSession(legacyUserDataDir);
    if (!legacy.host && !legacy.token) return false;
    writeSession(userDataDir, legacy, vault);
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
export function readSession(userDataDir, vault) {
  const { session, plaintext } = parseSession(userDataDir, vault);
  // Transparent migration: a token an older build left in plaintext is
  // re-sealed now, so the owner stays paired and the file stops carrying it.
  if (plaintext && canSeal(vault)) {
    try {
      writeSession(userDataDir, session, vault);
    } catch (error) {
      console.warn('[belay] could not re-save the session encrypted:', error);
    }
  }
  return session;
}

/** Parse the session file; `plaintext` flags a non-empty unencrypted token. */
function parseSession(userDataDir, vault) {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(userDataDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { session: { ...EMPTY }, plaintext: false };
    }
    const session = {
      host: typeof parsed.host === 'string' ? parsed.host : '',
      token: open('token', parsed, vault),
      label: typeof parsed.label === 'string' ? parsed.label : '',
      // What a host that proves its identity issued at pairing (src/proof.js):
      // the certificate fingerprint pinned for it, and the challenge handle
      // plus secret. Empty for a pairing made before the host had them.
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '',
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : '',
      secret: open('secret', parsed, vault),
      // The host's platform, remembered so a display window knows which
      // modifier map to build before the host has answered anything.
      platform: typeof parsed.platform === 'string' ? parsed.platform : '',
      keymap: keymapModeOf(parsed.keymap),
    };
    const plaintext = (typeof parsed.token === 'string' && parsed.token !== '')
      || (typeof parsed.secret === 'string' && parsed.secret !== '');
    return { session, plaintext };
  } catch {
    return { session: { ...EMPTY }, plaintext: false };
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
export function writeSession(userDataDir, session, vault) {
  const file = sessionPath(userDataDir);
  const { tokenEnc: _stale, secretEnc: _staleSecret, ...fields } = { ...EMPTY, ...session };
  const record = { ...fields, ...seal('token', fields.token, vault), ...seal('secret', fields.secret, vault) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort; see above */ }
}

export function clearSession(userDataDir) {
  writeSession(userDataDir, EMPTY);
}
