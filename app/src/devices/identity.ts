// Deciding whether the machine that just answered is the one we saved.
//
// A saved computer is keyed on the host's stable id (see model.ts), never on a
// URL. But the address that answered a connect race is only *an* address — the
// host reachable there can have changed identity underneath us. The clearest
// way that happens: the owner resets pairing on the computer, the host mints a
// fresh id, and now the same LAN IP answers as a different machine. Our saved
// token was issued to the old identity, so every authenticated call against the
// new one 401s — yet /health answers `ok`, so the race is happy to call it a
// success and show a dead 'connected' state.
//
// This module turns the reported id into an explicit verdict so `connectTo`
// never silently accepts a stranger. Pure and dependency-light on purpose, so
// identity.test.mjs can load it under `node --test` with no bundler.

// The synthesised-id prefix from migrateLegacy (model.ts). Re-stated rather
// than imported so this stays a pure module with no runtime sibling import —
// the pattern every module here that node --test loads directly follows, since
// only erasable type imports survive the loader. Kept in lockstep with
// model.ts's `isLegacyId`.
const LEGACY_ID_PREFIX = 'legacy:';

function isLegacyId(id: string): boolean {
  return id.startsWith(LEGACY_ID_PREFIX);
}

/**
 * What to do with a connect winner given the host id it reported.
 *
 * - `match`      the reported id equals the saved id — connect for real.
 * - `mismatch`   the host reported a *different* id — not this computer; the
 *                token would 401, so treat it as unreachable, not connected.
 * - `adopt`      a migrated (`legacy:`) entry reached a host that reports a real
 *                id — take that id over as the entry's key.
 * - `unknown`    no id was reported (an older host). Nothing to verify against,
 *                so proceed as before rather than inventing a failure.
 */
export type IdentityVerdict = 'match' | 'mismatch' | 'adopt' | 'unknown';

/**
 * Reconcile a saved device's id with the id the winning host reported.
 *
 * `winnerHostId` is `undefined` when the host reported none (a host old enough
 * to predate /health identity). For a legacy entry any reported id is adopted;
 * for a real-id entry the reported id must match, and a mismatch is the reset
 * described above.
 */
export function checkHostIdentity(
  deviceId: string,
  winnerHostId: string | undefined,
): IdentityVerdict {
  if (isLegacyId(deviceId)) {
    return winnerHostId ? 'adopt' : 'unknown';
  }
  if (!winnerHostId) return 'unknown';
  return winnerHostId === deviceId ? 'match' : 'mismatch';
}
