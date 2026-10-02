// The listener the tunnel sidecar pipes into, and the rule that makes tunneled
// traffic REMOTE in the eyes of every other file.
//
// Every loopback privilege the host grants keys on `req.socket.remoteAddress`:
// transport.ts (plain HTTP allowed from loopback), attach-secret.ts and
// agent-attach.ts (the attach CLI), hooks-routes.ts (Claude Code hooks), the
// inline check on /agent/approval-request in index.ts (the MCP sidecar),
// tailnet.ts (code-less pairing for CGNAT peers), discover-hosts.ts, and
// bwp-stream.ts (where the UDP video goes). The sidecar connects from
// 127.0.0.1, so without this file an account's phones would inherit all of it.
//
// So the sidecar gets its own listener, and every socket it delivers is tagged
// `tunnel:<nodeId>` before HTTP parses a byte. A non-IP string fails every
// check above closed — not loopback, not a tailnet address, not a UDP target
// the streamer can be aimed at — so the tunnel gets exactly the LAN rules:
// TLS with the pinned certificate, the device token, nothing extra. The
// node id makes each phone its own client for pair-replay binding, the
// pair-guard buckets and the notifications, instead of one shared "tunnel".
//
// Only the sidecar speaks the header. Every stream begins with one line,
// `belay-tunnel/2 <launch secret> <64 lowercase hex>\n`, then the TLS
// ClientHello. The secret is 32 random bytes the host mints per launch and
// hands the sidecar in its environment (tunnel.ts): this port is loopback,
// and without the secret any local process (another macOS user, a sandboxed
// app) could claim to be an allow-listed phone. The old secret-less
// `belay-tunnel/1` line is refused. Anything else — a raw ClientHello, plain
// HTTP, a wrong secret, a malformed id — is dropped without a byte in reply:
// a local process that found the port learns nothing.
//
// The TLS handshake is done here rather than by an https.Server because a
// TLSSocket reports the kernel's peer address, not the wrapped socket's, and
// the only link from the TLSSocket back to the raw socket is a private field.
// Building the TLSSocket ourselves keeps the identity in hand with public API
// only (see tunnel-trust-guard.test.ts).

import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, RequestListener } from 'node:http';
import type { Duplex } from 'node:stream';
import { createSecureContext, TLSSocket } from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { PLAINTEXT_REFUSED, PLAINTEXT_REFUSED_STATUS } from './transport.js';

const TLS_HANDSHAKE = 0x16;
/** Longest header line we will buffer before giving up on a peer. */
const MAX_HEADER_BYTES = 192;
/** Only the sidecar connects here, and it sends the header first thing. */
export const HEADER_TIMEOUT_MS = 5_000;
const HEADER_RE = /^belay-tunnel\/2 ([0-9a-f]{64}) ([0-9a-f]{64})$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

/** A fresh per-launch stream secret: 32 random bytes, 64 lowercase hex. */
export function newStreamSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Prefix of `req.socket.remoteAddress` for anything that came through the tunnel. */
export const TUNNEL_REMOTE_ADDRESS = 'tunnel:';

export function tunnelRemoteAddress(nodeId: string): string {
  return `${TUNNEL_REMOTE_ADDRESS}${nodeId}`;
}

/** The node id from a header line carrying `secret`, or null for anything else. */
export function parseTunnelHeader(line: string, secret: string): string | null {
  const m = HEADER_RE.exec(line);
  if (!m || !SECRET_RE.test(secret)) return null;
  // Constant time: the secret is the only thing standing between a local
  // process and every allow-listed phone's identity.
  return timingSafeEqual(Buffer.from(m[1], 'latin1'), Buffer.from(secret, 'latin1')) ? m[2] : null;
}

export interface TunnelListenerDeps {
  readonly app: RequestListener;
  readonly tls: { readonly key: string | Buffer; readonly cert: string | Buffer };
  /** The per-launch stream secret the sidecar was started with. */
  readonly secret: string;
  readonly onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Test hook: how long a peer may stall before or during the handshake. */
  readonly handshakeTimeoutMs?: number;
}

/** Mark a socket as tunnel traffic from `nodeId`. Exported for the test. */
export function markRemote(socket: Duplex, nodeId: string): void {
  Object.defineProperty(socket, 'remoteAddress', { value: tunnelRemoteAddress(nodeId), configurable: true });
}

const refusal = (): string => {
  const body = JSON.stringify(PLAINTEXT_REFUSED);
  return `HTTP/1.1 ${PLAINTEXT_REFUSED_STATUS} Upgrade Required\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
};

/** Read the header line; resolves with the node id and whatever followed, or null to drop. */
function readHeader(socket: Socket, secret: string, cb: (nodeId: string | null, rest: Buffer) => void): void {
  let buf = Buffer.alloc(0);
  const onTimeout = () => done(null, buf);
  const done = (nodeId: string | null, rest: Buffer) => {
    socket.off('data', onData);
    socket.setTimeout(0, onTimeout);
    socket.pause();
    cb(nodeId, rest);
  };
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > MAX_HEADER_BYTES) done(null, buf);
      return;
    }
    done(parseTunnelHeader(buf.subarray(0, nl).toString('latin1'), secret), buf.subarray(nl + 1));
  };
  // A peer that never finishes the line (a raw ClientHello has no newline)
  // must not hold a socket open forever.
  socket.setTimeout(HEADER_TIMEOUT_MS, onTimeout);
  socket.on('data', onData);
}

/** A net.Server for the caller to `listen(0, '127.0.0.1')`. */
export function createTunnelListener(deps: TunnelListenerDeps): NetServer {
  const secureContext = createSecureContext({ key: deps.tls.key, cert: deps.tls.cert });
  const http = createHttpServer(deps.app);
  if (deps.onUpgrade) http.on('upgrade', deps.onUpgrade);

  return createNetServer({ noDelay: true }, (socket: Socket) => {
    socket.on('error', () => { /* handed-off sockets get the http server's handler */ });
    readHeader(socket, deps.secret, (nodeId, rest) => {
      if (!nodeId) { socket.destroy(); return; }
      // A valid header is not a licence to idle: a local process that sends
      // one and then stalls (or never finishes the ClientHello) would hold a
      // socket forever, since this TLSSocket has no tls.Server to time it out.
      const onStall = () => socket.destroy();
      socket.setTimeout(deps.handshakeTimeoutMs ?? HEADER_TIMEOUT_MS, onStall);
      if (rest.length > 0) socket.unshift(rest);
      const sniff = () => {
        const first = socket.read(1) as Buffer | null;
        if (first === null) { socket.once('readable', sniff); return; }
        if (first[0] !== TLS_HANDSHAKE) { socket.end(refusal()); return; }
        socket.unshift(first);
        const tls = new TLSSocket(socket, { isServer: true, secureContext });
        markRemote(tls, nodeId);
        tls.on('error', () => { /* a failed handshake closes the socket; nothing to do */ });
        tls.once('secure', () => { socket.setTimeout(0, onStall); http.emit('connection', tls); });
      };
      sniff();
    });
  });
}
