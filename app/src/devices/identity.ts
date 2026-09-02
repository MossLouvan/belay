// Whether the machine that just answered /health is the one we saved.
//
// A saved computer is keyed on the host's own stable id, never on a URL,
// precisely because the URL is the thing that changes — DHCP hands a saved LAN
// address to a different machine on the next lease, and a tunnel address can be
// reassigned too. The connect race probes those addresses and takes whoever
// answers first; without this check "whoever answers" could be a *different*
// computer, and it would then be handed this pairing's bearer token on every
// authed request. The id is the guard against that: the winner is only accepted
// if it proves it is the same host.
//
// Pure module — no React, no network, no imports — so identity.test.mjs can
// exercise every branch with plain values. The `isLegacy` decision stays with
// `isLegacyId` in model.ts and is passed in, rather than duplicated here.

/**
 * True when a probe that reported `reportedId` may be accepted as `expectedId`.
 *
 * Three cases, in order:
 *
 *   1. No id reported. Older hosts (and the /health of anything that merely
 *      answers ok) may not carry one; there is nothing to compare against, so
 *      the ok result stands on its own as before. Callers still gate on ok.
 *   2. `isLegacy` — `expectedId` is a synthesised `legacy:` id from the pre-v1
 *      migration. Such an entry has no real id yet and adopts the first real
 *      one it meets, so any reported id is acceptable here.
 *   3. A normal entry. The machine that answered must be the exact one saved —
 *      a different real id means a different computer answered on a reused
 *      address, and it must be rejected so the token is never sent to it.
 */
export function hostIdentityMatches(
  expectedId: string,
  reportedId: string | undefined,
  isLegacy: boolean,
): boolean {
  if (!reportedId) return true;
  if (isLegacy) return true;
  return reportedId === expectedId;
}
