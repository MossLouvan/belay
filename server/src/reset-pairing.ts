// Reopening the pairing window without throwing the machine's identity away.
//
// The old remedy the app printed was `rm -f belay-state.json` then `npm start`.
// That does reopen pairing — a host with no devices issues a code again — but
// belay-state.json holds far more than device tokens. Deleting it makes the
// host mint a brand-new `hostId` on the next boot (emptyState() in state.ts),
// and the app keys every saved computer on that id. The phone's saved entry is
// suddenly orphaned, the renamed `label` is reset to the hostname, and
// re-pairing appends a *second* entry for the one physical machine.
//
// The honest reset clears only the paired devices and keeps identity. The host
// already has that operation — `revokeAll()` — so all this module contributes
// is recognising the flag that asks for it. Kept pure and free of imports so
// reset-pairing.test.ts can exercise it directly.

/** The flag `reopenPairingCommand` prints and this host recognises at boot. */
export const RESET_PAIRING_FLAG = '--reset-pairing';

/**
 * Whether the process was asked to clear pairings on this boot.
 *
 * Matches the exact flag only — a stray substring must not silently wipe every
 * paired phone. `argv` is normally `process.argv.slice(2)`.
 */
export function wantsPairingReset(argv: readonly string[]): boolean {
  return argv.includes(RESET_PAIRING_FLAG);
}
