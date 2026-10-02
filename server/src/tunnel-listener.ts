// The listener tunnel traffic enters through — and the one rule it enforces:
// nothing that arrives here is ever treated as loopback.
//
// The belay-net sidecar (tunnel.ts) pipes every QUIC stream from a phone to a
// TCP port on 127.0.0.1. Seen from a socket, that traffic IS loopback, and the
// host grants loopback real privileges: plain HTTP (transport.plaintextAllowed),
// the attach CLI routes (attach-secret.isLoopback), Claude Code hooks
// (hooks-routes), the MCP approval sidecar's /agent/approval-request, and
// code-less pairing for tailnet peers (tailnet.couldBeTailnet). Every one of
// those decisions keys on `req.socket.remoteAddress`. So this listener hands
// its sockets to a DEDICATED https server whose sockets report a remote
// address that is not an IP at all: `tunnel`. It is not loopback, not a
// tailnet range, not something a UDP video stream can be aimed at
// (bwp-stream.normalizeAddress passes it through and the streamer refuses
// it). Every guard fails closed without knowing this file exists — the tunnel
// gets exactly what a LAN client gets, and nothing more.
//
// Plain HTTP never reaches the app from here: the first byte is sniffed as in
// transport.ts and anything but a TLS ClientHello gets the same 426 the LAN
// gets. The phone pins the host certificate against 127.0.0.1:<localPort>, so
// inside the tunnel it is still the host's own TLS plus the device token.

import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { RequestListener } from 'node:http';

import { PLAINTEXT_REFUSED, PLAINTEXT_REFUSED_STATUS } from './transport.js';

const TLS_HANDSHAKE = 0x16;

/** What `req.socket.remoteAddress` says for anything that came through the tunnel. */
export const TUNNEL_REMOTE_ADDRESS = 'tunnel';

export interface TunnelListenerDeps {
  readonly app: RequestListener;
  readonly tls: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** Mark a socket as tunnel traffic. Exported for the one test that checks it. */
export function markRemote(socket: Duplex): void {
  Object.defineProperty(socket, 'remoteAddress', { value: TUNNEL_REMOTE_ADDRESS, configurable: true });
}

const refusal = (): string => {
  const body = JSON.stringify(PLAINTEXT_REFUSED);
  return `HTTP/1.1 ${PLAINTEXT_REFUSED_STATUS} Upgrade Required\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
};

/** A net.Server for the caller to `listen(0, '127.0.0.1')`. */
export function createTunnelListener(deps: TunnelListenerDeps): NetServer {
  const secure = createHttpsServer({ key: deps.tls.key, cert: deps.tls.cert }, deps.app);
  // 'secureConnection' fires with the TLSSocket that becomes `req.socket`,
  // before any HTTP byte is parsed — the only moment to tag it.
  secure.on('secureConnection', markRemote);
  if (deps.onUpgrade) secure.on('upgrade', deps.onUpgrade);

  return createNetServer({ noDelay: true }, (socket: Socket) => {
    socket.on('error', () => { /* handed-off sockets get the https server's handler */ });
    const sniff = () => {
      const first = socket.read(1) as Buffer | null;
      if (first === null) { socket.once('readable', sniff); return; }
      if (first[0] !== TLS_HANDSHAKE) { socket.end(refusal()); return; }
      socket.unshift(first);
      secure.emit('connection', socket);
    };
    sniff();
  });
}
