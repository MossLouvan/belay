// What the terminal shows while nothing is paired: a scannable QR and the same
// code in plain digits underneath.
//
// Split out of banner.ts and index.ts because the two of them used to disagree.
// The banner printed the QR once at boot; the rotation loop, five minutes
// later, minted a fresh code and printed only a text line — leaving a QR
// scrolled above that still encoded the dead boot code. Scanning it failed
// ("That code didn't work") while the code was plainly on screen, and every
// such scan spent one of the client's five failures toward a 15-minute lockout.
//
// The fix is structural: there is now one function that emits the QR and the
// code together, and both boot and rotation call it. A QR and a code that
// disagree is no longer expressible.
//
// Pure module — the QR renderer and the line printer are injected, so
// pairing-display.test.ts drives the whole thing without a real terminal.

import type { HostAddress } from './addresses.js';
import { buildAddresses } from './addresses.js';
import { buildPairLink } from './pair-link.js';

export interface PairingHostInfo {
  readonly hostId: string;
  readonly label: string;
  readonly platform: string;
  readonly port: number;
}

/** Output sinks, injected so tests can capture what would reach the terminal. */
export interface PairingDisplaySinks {
  /** Render a QR encoding this `belay://pair` link. */
  readonly qr: (link: string) => void;
  /** Print one plain console line. */
  readonly line: (text: string) => void;
}

/**
 * The `belay://pair` link a QR must encode for `code`, or null when the host
 * has no reachable address to advertise (nothing to point a phone at).
 *
 * `addresses` is injectable purely so tests are deterministic; in production it
 * defaults to the machine's live interfaces.
 */
export function pairingQrLink(
  info: PairingHostInfo,
  code: string,
  addresses: readonly HostAddress[] = buildAddresses(info.port),
): string | null {
  if (addresses.length === 0) return null;
  return buildPairLink({
    hostId: info.hostId,
    label: info.label,
    platform: info.platform,
    code,
    addresses,
  });
}

/**
 * Emit the QR and the manual code line together for `code`.
 *
 * This is the single place either display path renders a live code, so the QR
 * and the digits under it can never name different codes. When there is no
 * reachable address the QR is skipped but the code line still prints — the
 * manual path is exactly the fallback for a terminal that cannot show a QR.
 */
export function emitPairingCode(
  info: PairingHostInfo,
  code: string,
  expiresInSec: number,
  sinks: PairingDisplaySinks,
  addresses: readonly HostAddress[] = buildAddresses(info.port),
): void {
  const link = pairingQrLink(info, code, addresses);
  if (link) sinks.qr(link);
  sinks.line(
    `  ...or type it in manually — code: ${code}   (expires in ${expiresInSec}s)`,
  );
}
