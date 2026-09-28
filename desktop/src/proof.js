// The desktop's half of the host-identity proof (server/src/device-proof.ts).
//
// Before the saved token is sent to a host, the host must show it holds the
// secret this client was issued at pairing: a fresh nonce out, HMAC-SHA256
// over it under that secret back. The host id alone is public and proves
// nothing. Runs in the renderer on WebCrypto, so `subtle` is injected and
// test/proof.test.mjs drives it with Node's.

export const PROOF_CONTEXT = 'belay-host-proof:v1:';
export const NONCE_BYTES = 16;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {{ subtle: SubtleCrypto }} crypto */
export async function expectedProof(secret, nonce, crypto) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(PROOF_CONTEXT + String(nonce).toLowerCase()));
  return hex(new Uint8Array(mac));
}

export async function proofMatches(secret, nonce, offered, crypto) {
  if (typeof offered !== 'string') return false;
  return offered.toLowerCase() === await expectedProof(secret, nonce, crypto);
}

/** @param {{ getRandomValues: (a: Uint8Array) => Uint8Array }} crypto */
export function freshNonce(crypto) {
  return hex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/** A SHA-256 fingerprint in any spelling (colons, spaces, case) → 64 lowercase hex, or null. */
export function normalizeFingerprint(value) {
  const clean = String(value ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return clean.length === 64 ? clean : null;
}

/** The fingerprint as a person compares it with the host's banner: 8 groups of 8. */
export function displayFingerprint(fingerprint) {
  return (fingerprint.match(/.{1,8}/g) ?? []).join(' ').toUpperCase();
}

/**
 * Whether plain http to `origin` is acceptable: only where the link is
 * private without TLS — this machine, or a Tailscale peer.
 */
export function plaintextOk(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return host.endsWith('.ts.net');
}
