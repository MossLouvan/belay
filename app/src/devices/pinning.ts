// Certificate pinning, as the JS side sees it.
//
// The host serves the LAN over TLS with a self-signed certificate. React
// Native's fetch and WebSocket cannot pin one from JS, so the native module
// `BelayPin` (app/modules/belay-stream/ios/BelayPinModule.swift) holds a table
// of host:port → SHA-256 and accepts a server trust only when the leaf
// certificate hashes to the pinned value. This file is the only place that
// table is written from, and the only place that reads the two other things
// the native side offers: the fingerprint a never-seen host presents (for a
// typed pairing, where the QR did not carry it) and real random bytes.
//
// Where there is no native module — the web build, Expo Go — pins are kept
// here anyway so the trust decision (verify-host.ts) still runs; the browser
// then applies its own certificate policy, which for a self-signed host means
// the connection fails rather than proceeding unpinned.

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

interface BelayPinNative {
  /** Trust `fingerprint` (64 lowercase hex) for TLS connections to host:port. */
  pin(host: string, port: number, fingerprint: string): void;
  unpin(host: string, port: number): void;
  /** The SHA-256 of the leaf certificate `url` presents, without trusting it. */
  probeFingerprint(url: string): Promise<string>;
  randomHex(bytes: number): string;
}

const native: BelayPinNative | null = Platform.OS === 'web' ? null : requireOptionalNativeModule<BelayPinNative>('BelayPin');

/** Whether TLS pinning is actually enforced on this build. */
export const pinningAvailable = native !== null;

const pins = new Map<string, string>();

/** `host:port` as the native table keys it; 443 when https omits the port. */
export function pinKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return `${u.hostname.toLowerCase()}:${u.port || '443'}`;
  } catch {
    return null;
  }
}

/** Pin `fingerprint` for every https address in `urls`. No-op for http ones. */
export function pinAddresses(urls: readonly string[], fingerprint: string): void {
  for (const url of urls) {
    const key = pinKey(url);
    if (!key) continue;
    pins.set(key, fingerprint);
    const [host, port] = key.split(':');
    native?.pin(host, Number(port), fingerprint);
  }
}

export function unpinAddresses(urls: readonly string[]): void {
  for (const url of urls) {
    const key = pinKey(url);
    if (!key) continue;
    pins.delete(key);
    const [host, port] = key.split(':');
    native?.unpin(host, Number(port));
  }
}

/** The fingerprint pinned for `url`, if any. */
export function pinnedFingerprint(url: string): string | undefined {
  const key = pinKey(url);
  return key ? pins.get(key) : undefined;
}

/**
 * Whether the native layer is enforcing `fingerprint` for `url` right now —
 * the one fact verify-host.ts may skip the HMAC challenge on. False on web
 * and Expo Go (no native module), for http, and for a fingerprint the native
 * side would have refused to store (it only keeps 64 hex digits).
 */
export function pinEnforced(url: string, fingerprint: string | undefined): boolean {
  if (!pinningAvailable || !fingerprint || !/^[0-9a-f]{64}$/i.test(fingerprint)) return false;
  return pinnedFingerprint(url) === fingerprint;
}

/**
 * What certificate a host presents, before anything is trusted.
 *
 * Only for a typed pairing: the QR carries the fingerprint, but an address
 * typed by hand does not, so the phone shows this one next to the code field
 * for the user to compare with the host's screen. Null where the native
 * module is absent (web) — the browser decides there.
 */
export async function probeFingerprint(url: string): Promise<string | null> {
  if (!native) return null;
  try {
    const hex = (await native.probeFingerprint(url)).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return hex.length === 64 ? hex : null;
  } catch {
    return null;
  }
}

/** Random bytes: WebCrypto where it exists, the native module otherwise. */
export function randomBytes(n: number): Uint8Array {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues) return webCrypto.getRandomValues(new Uint8Array(n));
  if (!native) throw new Error('no source of randomness on this platform');
  const hex = native.randomHex(n);
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}
