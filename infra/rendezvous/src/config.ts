// Rendezvous configuration: read once at boot, validated, frozen.
//
// Fail-fast on purpose: a rendezvous that boots without a TURN secret would
// mint credentials no coturn accepts, which presents as "relay never works"
// hours later in a client log. Refusing to start is the kinder failure.

export interface RendezvousConfig {
  readonly port: number;
  /** Shared secret for TURN REST credentials — must match coturn's
   *  `static-auth-secret`. Never logged, never sent to any peer. */
  readonly turnSecret: string;
  /** TURN/TURNS URIs handed to peers alongside minted credentials. */
  readonly turnUrls: readonly string[];
}

export type ConfigResult =
  | { readonly ok: true; readonly config: RendezvousConfig }
  | { readonly ok: false; readonly error: string };

const MIN_SECRET_BYTES = 32;

export function loadConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const portRaw = env.BELAY_RENDEZVOUS_PORT ?? '8790';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `invalid BELAY_RENDEZVOUS_PORT: ${portRaw}` };
  }

  const turnSecret = env.BELAY_TURN_SECRET ?? '';
  if (Buffer.byteLength(turnSecret, 'utf8') < MIN_SECRET_BYTES) {
    return {
      ok: false,
      error: `BELAY_TURN_SECRET missing or shorter than ${MIN_SECRET_BYTES} bytes — generate one with: openssl rand -hex 32`,
    };
  }

  const urlsRaw = (env.BELAY_TURN_URLS ?? '').split(',').map((u) => u.trim()).filter((u) => u.length > 0);
  if (urlsRaw.length === 0) {
    return {
      ok: false,
      error: 'BELAY_TURN_URLS missing — e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp"',
    };
  }
  for (const url of urlsRaw) {
    if (!/^turns?:[A-Za-z0-9.:\-\[\]]+(\?transport=(udp|tcp))?$/.test(url)) {
      return { ok: false, error: `invalid TURN url: ${url}` };
    }
  }

  return { ok: true, config: Object.freeze({ port, turnSecret, turnUrls: Object.freeze(urlsRaw) }) };
}
