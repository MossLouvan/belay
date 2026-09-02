// Pure token-resolution rules for the keychain-backed device store.
//
// Extracted from storage.ts (which imports Expo native modules and so cannot be
// unit-tested) precisely so the rule that prevents PERMANENT TOKEN LOSS can be
// tested directly.
//
// The bug this closes: a transient keychain read failure (the phone is locked
// when the store loads) used to coerce the token to '', which parseStore drops,
// which removes the device from the store, which makes the very next save delete
// its real keychain entry — turning a momentary read glitch into a permanent
// un-pairing. The fix distinguishes "entry genuinely absent" from "read failed".

/** Sentinel stored on disk in place of a token that lives in the keychain. */
export const SECURE_MARK = '<keychain>';

/** Outcome of a keychain read for one device. */
export type KeychainRead =
  | { readonly kind: 'value'; readonly token: string } // entry present
  | { readonly kind: 'absent' }                          // entry genuinely missing
  | { readonly kind: 'failed' };                         // read threw (locked, IO error)

/**
 * The token a device should carry after a load, given what its on-disk blob held
 * and what the keychain read returned.
 *
 * - Not a marker → the on-disk token stands (web / migration paths).
 * - Marker + value → the real token.
 * - Marker + absent → '' so parseStore drops it; the user pairs again. This is
 *   a genuine loss the user can see and recover from.
 * - Marker + failed → keep the marker UNRESOLVED. The device survives parseStore
 *   (a non-empty token), stays in the store, and is therefore never deleted by a
 *   later save. The next successful load resolves it.
 */
export function resolveLoadedToken(rawToken: string, read: KeychainRead): string {
  if (rawToken !== SECURE_MARK) return rawToken;
  switch (read.kind) {
    case 'value':
      return read.token;
    case 'absent':
      return '';
    case 'failed':
      return SECURE_MARK;
  }
}

/** True when a device's token is still the unresolved marker after a load — its
 *  real keychain entry must be left untouched on save, never overwritten with the
 *  marker and never deleted. */
export function isUnresolved(token: string): boolean {
  return token === SECURE_MARK;
}
