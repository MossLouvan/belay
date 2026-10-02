// Random credentials and hashing. Credentials are shown once; only SHA-256 hex
// ever reaches D1.

const enc = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** 32 random bytes, base64url: session tokens, host secrets, host credentials. */
export const randomCredential = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const CLAIM_CODE_RE = /^[A-Z2-7]{8}$/;

/** 8-char base32 claim code (40 bits). */
export function claimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => BASE32[b & 31]).join('');
}

/** 6-digit email code, zero-padded, unbiased (rejection sampling). */
export function emailCode(): string {
  const LIMIT = 4_294_000_000; // largest multiple of 1e6 below 2^32
  let n: number;
  do n = crypto.getRandomValues(new Uint32Array(1))[0];
  while (n >= LIMIT);
  return (n % 1_000_000).toString().padStart(6, '0');
}

export const newId = (): string => crypto.randomUUID();

export const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Verifies a raw 64-byte Ed25519 signature over `message` by the 32-byte key `publicKey`. */
export async function verifyEd25519(publicKey: Uint8Array, message: string, signature: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']).catch(() => null);
  if (!key) return false;
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, enc.encode(message));
}
