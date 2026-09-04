// The BWP streaming session: spawning and supervising `belay-stream`.
//
// This is the replacement for the JPEG loop. That loop lived inside the
// WebSocket handler because it *was* the transport; this one is not — the
// pixels leave over UDP, and the WebSocket's only remaining job for video is to
// agree on keys and report what happened. So the loop becomes a child process
// and this module is the thin, testable part around it.
//
// Two decisions here are security-relevant and worth stating plainly:
//
//  * The media key is generated fresh per session and is NOT the pairing token.
//    Reusing a long-lived pairing credential as a media key means one recovered
//    stream key is a permanent device compromise. A per-session key means it is
//    one session.
//  * The key reaches the child on stdin, never argv. On Windows any process can
//    read another's command line, so a key in argv is a key handed to every
//    program the user runs.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the compiled streamer lives, preferring a release build. */
export function streamerPath(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    join(__dirname, '..', 'native', 'belay-stream.exe'),
    join(__dirname, '..', '..', 'crates', 'belay-stream', 'target', 'release', 'belay-stream.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Is the BWP path usable on this host at all? */
export function bwpAvailable(): boolean {
  return streamerPath() !== null;
}

export interface BwpRequest {
  /** The client's UDP port, where frames will be sent. */
  readonly port: number;
  /** The client's address, taken from the socket — never from the client. */
  readonly address: string;
  readonly preset?: string;
  readonly fps?: number;
  readonly monitor?: number;
}

/** What the client needs in order to receive and decrypt the stream. */
export interface BwpOffer {
  readonly port: number;
  readonly key: string;
  readonly salt: string;
  readonly width: number;
  readonly height: number;
  /** 'gpu' when the host is doing zero-copy capture; 'cpu' otherwise. */
  readonly path: string;
}

export type BwpEvent =
  | { readonly type: 'ready'; readonly offer: BwpOffer }
  | { readonly type: 'stats'; readonly fps: number; readonly kbps: number; readonly bitrate: number }
  | { readonly type: 'bitrate'; readonly bps: number }
  | { readonly type: 'error'; readonly error: string }
  | { readonly type: 'exit'; readonly code: number | null };

/**
 * A UDP port a client may legitimately be listening on.
 *
 * Ports below 1024 are privileged and no phone binds one; a client claiming
 * port 22 or 445 is either broken or trying to aim our packet stream at
 * something on its own network. Refuse rather than help.
 */
export function validPort(raw: unknown): number | null {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return null;
  return n;
}

/**
 * Normalise the address Node reports for a socket into one Rust can parse.
 *
 * Node hands back IPv4-mapped IPv6 (`::ffff:192.168.1.5`) whenever the listener
 * is dual-stack, which is the normal case. Passing that straight through gives
 * the streamer an address it cannot parse, and the stream fails with an error
 * that points at the config parser rather than at this.
 *
 * Returns null for anything that is not a usable remote address, so a socket
 * with no peer cannot become `undefined:41234`.
 */
export function normalizeAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return mapped[1];
  // A bare IPv6 address needs brackets before a port can be appended to it.
  if (raw.includes(':') && !raw.startsWith('[')) {
    // Strip any zone index: Rust's parser rejects `fe80::1%eth0`.
    const zoneless = raw.split('%')[0];
    return `[${zoneless}]`;
  }
  return raw;
}

const PRESETS = new Set(['auto', 'data-saver', 'balanced', 'high', 'max']);

/** The requested preset, or 'auto' for anything unrecognised. */
export function validPreset(raw: unknown): string {
  return typeof raw === 'string' && PRESETS.has(raw) ? raw : 'auto';
}

/**
 * Frames per second the host will attempt.
 *
 * Clamped for the same reason the JPEG path clamps it: an unbounded fps turns
 * the capture loop into a spin loop. The streamer clamps again on its side —
 * neither end trusts the other to have done it.
 */
export function validFps(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 60;
  return Math.min(120, Math.max(1, n));
}

/** Parse one line of the streamer's stdout. Unknown shapes are ignored. */
export function parseStreamerLine(line: string): BwpEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (msg.type) {
    case 'ready':
      if (typeof msg.port !== 'number') return null;
      return {
        type: 'ready',
        offer: {
          port: msg.port,
          key: '',
          salt: '',
          width: Number(msg.width) || 0,
          height: Number(msg.height) || 0,
          path: typeof msg.path === 'string' ? msg.path : 'cpu',
        },
      };
    case 'stats':
      return {
        type: 'stats',
        fps: Number(msg.fps) || 0,
        kbps: Number(msg.kbps) || 0,
        bitrate: Number(msg.bitrate) || 0,
      };
    case 'bitrate':
      return { type: 'bitrate', bps: Number(msg.bps) || 0 };
    case 'error':
      return { type: 'error', error: typeof msg.error === 'string' ? msg.error : 'stream failed' };
    default:
      return null;
  }
}

/**
 * A running stream. `stop()` is idempotent and safe to call from a socket close
 * handler, which is where it will usually be called from.
 */
export class BwpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private buffer = '';

  constructor(private readonly onEvent: (e: BwpEvent) => void) {}

  /**
   * Start the streamer.
   *
   * Resolves once it reports ready, or rejects if it fails to start. The offer
   * carries the freshly generated key, which the caller must deliver over the
   * already-authenticated control channel and nowhere else.
   */
  start(req: BwpRequest, timeoutMs = 10_000): Promise<BwpOffer> {
    const exe = streamerPath();
    if (!exe) return Promise.reject(new Error('the host streamer is not built for this platform'));

    const port = validPort(req.port);
    if (port === null) return Promise.reject(new Error('a valid client UDP port is required'));

    const address = normalizeAddress(req.address);
    if (address === null) return Promise.reject(new Error('the client has no usable address'));

    // Fresh per session. Not the pairing token: one recovered media key must
    // cost one session, not the device.
    const key = randomBytes(32).toString('hex');
    const salt = randomBytes(8).toString('hex');

    return new Promise<BwpOffer>((resolve, reject) => {
      const config = JSON.stringify({
        bind: '0.0.0.0:0',
        // The address comes from the socket, never from the client's message.
        // Taking it from the message would let a paired client redirect the
        // stream at a third party — an amplification primitive handed out for
        // free.
        peer: `${address}:${port}`,
        token: key,
        salt,
        preset: validPreset(req.preset),
        fps: validFps(req.fps),
        monitor: Math.max(0, Math.floor(Number(req.monitor) || 0)),
      });

      const child = spawn(exe, [], { windowsHide: true });
      this.child = child;

      const timer = setTimeout(() => {
        this.stop();
        reject(new Error('the host streamer did not start in time'));
      }, timeoutMs);

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        // Line-buffered: a JSON object split across two reads must not be
        // parsed as two broken halves.
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          const event = parseStreamerLine(line);
          if (!event) continue;
          if (event.type === 'ready') {
            const offer: BwpOffer = { ...event.offer, key, salt };
            settle(() => resolve(offer));
            this.onEvent({ type: 'ready', offer });
          } else {
            if (event.type === 'error') settle(() => reject(new Error(event.error)));
            this.onEvent(event);
          }
        }
      });

      child.on('error', (e) => settle(() => reject(e)));
      child.on('exit', (code) => {
        this.child = null;
        settle(() => reject(new Error(`the host streamer exited (${code})`)));
        this.onEvent({ type: 'exit', code });
      });

      // The key goes down stdin and the pipe is closed immediately. It never
      // touches argv, an environment variable, or a file.
      child.stdin.write(`${config}\n`);
      child.stdin.end();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    // A stuck encoder is a kill, not a hung server — which is most of why this
    // runs out of process at all.
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
