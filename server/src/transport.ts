// Transport security: one port that speaks both TLS and plain HTTP, and the
// rule for when plain is acceptable.
//
// Everything a paired device does — screen frames, keystrokes, a shell —
// rides on the bearer token, and until this file the token crossed the LAN in
// cleartext. Now the LAN gets HTTPS with the host's self-signed certificate
// (tls-cert.ts), which the clients pin by fingerprint. Plain HTTP survives
// for exactly two callers that are already private: this computer itself
// (loopback: the attach CLI, hooks, the local web build) and Tailscale peers
// (100.64.0.0/10, encrypted end to end by WireGuard). A plain request from
// anywhere else is refused with an answer that says what to do, because the
// alternative — silently accepting it — is the finding this file closes.
//
// Both protocols on ONE port, sniffed from the first byte, because the port
// is printed on screens, saved in phones and baked into pair links. A TLS
// ClientHello always begins with the handshake record type 0x16; no HTTP
// method starts with that byte.

import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

import { couldBeTailnet, normalizeIp } from './tailnet.js';

const TLS_HANDSHAKE = 0x16;

/** What a refused plaintext request is told. Stable: the app keys on `code`. */
export const PLAINTEXT_REFUSED = Object.freeze({
  error: 'Plain HTTP is only accepted from this computer or over Tailscale. ' +
    'Update the Belay app and pair with this computer again to connect securely on this network.',
  code: 'plaintext-refused',
});
/** 426 Upgrade Required: "use TLS" is precisely what it means. */
export const PLAINTEXT_REFUSED_STATUS = 426;

export function isLoopback(ip: string | undefined): boolean {
  const v = normalizeIp(ip);
  return v === '::1' || v.startsWith('127.');
}

/** Whether an unencrypted connection from `ip` is on a link that is private anyway. */
export function plaintextAllowed(ip: string | undefined): boolean {
  return isLoopback(ip) || couldBeTailnet(ip);
}

/** The socket facts the policy needs; `encrypted` is set on a TLSSocket. */
export interface TransportFacts {
  readonly encrypted?: boolean;
  readonly remoteAddress?: string;
}

/** Whether a request on this socket may proceed at all. */
export function transportAllowed(socket: TransportFacts): boolean {
  return socket.encrypted === true || plaintextAllowed(socket.remoteAddress);
}

/**
 * One listener, two servers. `plain` and `secure` never listen themselves;
 * each receives the sockets the sniffer hands it as if it had accepted them.
 */
export function createPolyglotServer(plain: HttpServer, secure: HttpsServer): NetServer {
  // TCP_NODELAY: this listener owns the handle, so the HTTP servers' own
  // noDelay never reaches it, and a click or a frame tail would otherwise
  // sit in Nagle's buffer waiting for the previous ACK.
  return createNetServer({ noDelay: true }, (socket: Socket) => {
    // A peer that connects and resets before the first byte would otherwise
    // raise an unhandled 'error' on a socket nobody owns yet.
    socket.on('error', () => { /* handed-off sockets get the http server's handler */ });
    const sniff = () => {
      const first = socket.read(1) as Buffer | null;
      if (first === null) { socket.once('readable', sniff); return; }
      socket.unshift(first);
      (first[0] === TLS_HANDSHAKE ? secure : plain).emit('connection', socket);
    };
    sniff();
  });
}
