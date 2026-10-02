// The phone's tunnel secret key and relay list, as pure functions.
//
// The key is 32 random bytes, generated once and kept in the keychain
// (tunnel-identity.ts owns the SecureStore side). It is the phone's iroh
// identity: lose it and the phone is a new node id the host no longer admits.
// The relays come from build config: the phone has no heartbeat to learn
// them from (design.md, Tunnel).

/** The production relay (infra/relay/README.md). */
export const DEFAULT_RELAY_URLS: readonly string[] = ['https://relay.gobelay.com'];

const SECRET_HEX = /^[0-9a-f]{64}$/;

export const isNodeId = (value: unknown): value is string => typeof value === 'string' && SECRET_HEX.test(value);

/**
 * The stored secret, or a fresh one written back. A stored value that is not
 * 64 hex digits is treated as absent: the FFI would refuse it anyway.
 */
export async function loadOrCreateTunnelSecret(
  read: () => Promise<string | null>,
  write: (secretHex: string) => Promise<void>,
  randomBytes: (n: number) => Uint8Array,
): Promise<string> {
  const stored = await read();
  if (isNodeId(stored)) return stored;
  const secret = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
  await write(secret);
  return secret;
}

/**
 * `EXPO_PUBLIC_RELAY_URLS`: comma-separated relay URLs; the default when unset
 * or empty. Plain http is kept: a development relay (`iroh-relay --dev`) has
 * no TLS, and the host's sidecar takes the same URL from the accounts service.
 * Dropping it silently sent the phone to the production relay, where the host
 * is not homed. The relay never sees plaintext either way (QUIC end to end).
 */
export function parseRelayUrls(env: string | undefined): readonly string[] {
  const urls = (env ?? '').split(',').map((u) => u.trim()).filter((u) => /^https?:\/\/./i.test(u));
  return urls.length > 0 ? urls : DEFAULT_RELAY_URLS;
}
