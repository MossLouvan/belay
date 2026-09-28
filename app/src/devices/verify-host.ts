// Is the machine that just answered the one we paired with? Decided BEFORE
// the bearer token is sent anywhere.
//
// Three facts feed the answer, in order of strength:
//
//   1. The link. An https address only answered because the native layer
//      accepted the certificate whose fingerprint this device pinned at
//      pairing (pinning.ts) — so the peer holds the host's private key. A
//      plain http address is acceptable only where the network is already
//      private: this phone's loopback, or Tailscale, which authenticates its
//      peers itself. Plain http anywhere else is refused by the host too
//      (server/src/transport.ts).
//   2. The proof. A device paired since secrets were issued challenges the
//      host (proof.ts): a random nonce out, an HMAC under the pairing secret
//      back. An impostor echoing /health cannot produce it.
//   3. The host id. Public, so never sufficient — but a different id at a
//      saved address is a reset host, and a missing id is a host too old to
//      trust (identity.ts).
//
// A device paired before secrets existed has no fingerprint and no secret,
// so it can only pass on a private link; on the LAN it is told to pair again
// rather than left staring at "offline".
//
// Pure apart from the injected challenge, so verify-host.test.mjs can drive
// every branch without a network.

import { checkHostIdentity } from './identity.ts';
import { nonceHex, proofMatches } from './proof.ts';

/** Why a host was refused — each has a different fix, so they stay distinct. */
export type TrustProblem =
  /** Nothing wrong with the host; this device's pairing predates TLS/proofs. Pair again. */
  | 'needs-repair'
  /** Something answered, but it is not (or cannot prove it is) the paired computer. */
  | 'identity';

export type TrustVerdict =
  | { readonly ok: true; readonly adoptId?: string }
  | { readonly ok: false; readonly problem: TrustProblem };

/** The parts of a saved computer the decision reads. */
export interface TrustSubject {
  readonly id: string;
  readonly deviceId?: string;
  readonly secret?: string;
  readonly fingerprint?: string;
}

export interface TrustInput {
  readonly device: TrustSubject;
  /** The address that answered. */
  readonly url: string;
  /** The id that address reported in /health, if any. */
  readonly reportedHostId?: string;
}

/** Ask `url` to prove itself for `deviceId`; resolves the proof, or null on any failure. */
export type Challenge = (url: string, deviceId: string, nonce: string) => Promise<string | null>;

const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Whether an address is on a link that is private without TLS: loopback or Tailscale. */
export function isPrivateLink(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  if (CGNAT.test(host)) return true;
  return host.endsWith('.ts.net');
}

function isHttps(url: string): boolean {
  return /^https:/i.test(url);
}

/** True for a device paired since the host issued proof secrets. */
export function hasProofSecret(device: TrustSubject): device is TrustSubject & { deviceId: string; secret: string } {
  return typeof device.deviceId === 'string' && device.deviceId.length > 0
    && typeof device.secret === 'string' && device.secret.length > 0;
}

export async function verifyHost(
  input: TrustInput,
  challenge: Challenge,
  randomBytes: (n: number) => Uint8Array,
): Promise<TrustVerdict> {
  const { device, url, reportedHostId } = input;

  const identity = checkHostIdentity(device.id, reportedHostId);
  if (identity === 'mismatch') return { ok: false, problem: 'identity' };
  const adoptId = identity === 'adopt' ? reportedHostId : undefined;

  // An https address that is not pinned should never have answered; if it
  // somehow did, the certificate was not checked, and that is a refusal.
  if (isHttps(url) && !device.fingerprint) return { ok: false, problem: 'needs-repair' };

  if (hasProofSecret(device)) {
    const nonce = nonceHex(randomBytes);
    const proof = await challenge(url, device.deviceId, nonce);
    if (!proofMatches(device.secret, nonce, proof)) return { ok: false, problem: 'identity' };
    return { ok: true, adoptId };
  }

  // No secret to prove with: only a link that authenticates the peer itself.
  if (isHttps(url) || isPrivateLink(url)) return { ok: true, adoptId };
  return { ok: false, problem: 'needs-repair' };
}
