// The phone's half of the host-identity proof (server/src/device-proof.ts).
//
// Before this app says `Authorization` to anything, the host has to show it
// knows the secret this device was issued at pairing: the phone sends a fresh
// nonce, the host answers HMAC-SHA256 over it under that secret. The host id
// in /health is public and proves nothing; this does. Pure module, so
// proof.test.mjs pins the same vector the host's own suite does.

import { hmacSha256, toHex, utf8 } from './hmac.ts';

export const PROOF_CONTEXT = 'belay-host-proof:v1:';
/** Nonce bytes. 16 is plenty for a value that only has to be fresh. */
export const NONCE_BYTES = 16;

/** The proof a genuine host produces for `nonce`. */
export function expectedProof(secret: string, nonce: string): string {
  return toHex(hmacSha256(utf8(secret), utf8(PROOF_CONTEXT + nonce.toLowerCase())));
}

/** Whether `offered` is the right proof. Not constant-time: the proof is not a secret. */
export function proofMatches(secret: string, nonce: string, offered: unknown): boolean {
  return typeof offered === 'string' && offered.toLowerCase() === expectedProof(secret, nonce);
}

/** Random bytes as lowercase hex, from whatever source the platform gives. */
export function nonceHex(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(NONCE_BYTES);
  if (bytes.length !== NONCE_BYTES) throw new Error('the randomness source returned the wrong length');
  return toHex(bytes);
}
