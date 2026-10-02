// Spawning and supervising `belay-net`, the tunnel sidecar
// (crates/belay-net-tunnel/src/bin/belay-net.rs).
//
// The sidecar owns the tunnel keypair (~/.belay/net-key, 0600) and the QUIC
// sockets; this module owns nothing but the process. Line protocol:
//   stdout  `ready <nodeId>` once, `sig <base64url>` per `sign`
//   stdin   `allow <id> <id>...` replaces the allow-list, `sign <message>`
// The key never crosses this boundary: the host asks the sidecar to sign the
// claim proof and sees only the signature.
//
// Restart on exit with the same backoff the native helper uses, and re-send
// the allow-list, which the new process does not have. The node id survives
// a restart because the key file does.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backoffDelay, isHealthyRun } from './backoff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Where the compiled sidecar lives, preferring the packaged copy. */
export function tunnelBinaryPath(): string | null {
  const candidates = [
    join(__dirname, '..', 'native', `belay-net${EXE}`),
    join(__dirname, '..', '..', 'crates', 'belay-net-tunnel', 'target', 'release', `belay-net${EXE}`),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function tunnelAvailable(): boolean {
  return tunnelBinaryPath() !== null;
}

export type SidecarLine = { readonly type: 'ready'; readonly nodeId: string } | { readonly type: 'sig'; readonly sig: string };

/** One stdout line, or null for anything that is not protocol. */
export function parseSidecarLine(line: string): SidecarLine | null {
  const m = /^(ready|sig)\s+(\S+)\s*$/.exec(line);
  if (!m) return null;
  if (m[1] === 'ready') return /^[0-9a-f]{64}$/.test(m[2]) ? { type: 'ready', nodeId: m[2] } : null;
  return /^[A-Za-z0-9_-]+$/.test(m[2]) ? { type: 'sig', sig: m[2] } : null;
}

export interface TunnelOptions {
  /** The host's tunnel listener port (tunnel-listener.ts). */
  readonly targetPort: number;
  readonly relayUrls?: readonly string[];
  readonly keyPath?: string;
  readonly binary?: string;
}

export interface Tunnel {
  /** Resolves on the first `ready`; stable across restarts. */
  readonly nodeId: Promise<string>;
  setAllowList(ids: readonly string[]): void;
  /** Restart with new relays if they differ from the running set. */
  setRelays(urls: readonly string[]): void;
  sign(message: string): Promise<string>;
  stop(): void;
}

const SIGN_TIMEOUT_MS = 10_000;

export function startTunnel(opts: TunnelOptions): Tunnel {
  const binary = opts.binary ?? tunnelBinaryPath();
  if (!binary) throw new Error('belay-net binary not found (npm run build:tunnel)');

  let proc: ChildProcessWithoutNullStreams | null = null;
  let relays = [...(opts.relayUrls ?? [])];
  let allow: readonly string[] = [];
  let stopped = false;
  let failures = 0;
  let startedAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  const pendingSigs: Array<(sig: string) => void> = [];
  let resolveReady!: (id: string) => void;
  const nodeId = new Promise<string>((r) => { resolveReady = r; });

  const write = (line: string) => { if (proc?.stdin.writable) proc.stdin.write(`${line}\n`); };

  const launch = (): void => {
    startedAt = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env, BELAY_NET_TARGET: `127.0.0.1:${opts.targetPort}`, BELAY_NET_RELAYS: relays.join(','),
      ...(opts.keyPath ? { BELAY_NET_KEY: opts.keyPath } : {}),
    };
    const p = spawn(binary, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    proc = p;
    p.on('error', (e) => console.error('[tunnel] spawn failed:', e.message));
    createInterface({ input: p.stdout }).on('line', (line) => {
      const msg = parseSidecarLine(line);
      if (!msg) { console.warn(`[tunnel] unexpected line: ${line}`); return; }
      if (msg.type === 'ready') { resolveReady(msg.nodeId); write(`allow ${allow.join(' ')}`); }
      else pendingSigs.shift()?.(msg.sig);
    });
    createInterface({ input: p.stderr }).on('line', (line) => console.log(`[tunnel] ${line}`));
    p.on('exit', (code) => {
      if (proc !== p) return;
      proc = null;
      if (stopped) return;
      failures = isHealthyRun(Date.now() - startedAt) ? 1 : failures + 1;
      const delay = backoffDelay(failures);
      console.warn(`[tunnel] belay-net exited (${code}); restarting in ${delay}ms`);
      restartTimer = setTimeout(() => { restartTimer = null; launch(); }, delay);
      restartTimer.unref();
    });
  };
  launch();

  return {
    nodeId,
    setAllowList: (ids) => { allow = [...ids]; write(`allow ${allow.join(' ')}`); },
    setRelays: (urls) => {
      // ponytail: a changed relay set restarts the sidecar rather than editing
      // the live endpoint; relays change at deploy time, not at runtime.
      const next = [...urls];
      if (next.join(',') === relays.join(',')) return;
      relays = next;
      proc?.kill();
    },
    sign: (message) => new Promise<string>((resolve, reject) => {
      if (/[\r\n]/.test(message)) { reject(new Error('sign: message must be one line')); return; }
      const timer = setTimeout(() => {
        const i = pendingSigs.indexOf(done);
        if (i >= 0) pendingSigs.splice(i, 1);
        reject(new Error('sign: sidecar did not answer'));
      }, SIGN_TIMEOUT_MS);
      const done = (sig: string) => { clearTimeout(timer); resolve(sig); };
      pendingSigs.push(done);
      write(`sign ${message}`);
    }),
    stop: () => {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      proc?.stdin.end();
      proc?.kill();
      proc = null;
    },
  };
}
