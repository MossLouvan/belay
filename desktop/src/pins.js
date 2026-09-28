// Certificate pinning for the desktop client, main-process side.
//
// The renderer talks to the host with Chromium's fetch and WebSocket, and
// Chromium decides certificate trust in the main process through
// `session.setCertificateVerifyProc`. That proc calls `decide` below for every
// TLS connection: a pinned origin is accepted only when the leaf certificate
// hashes to the fingerprint learned at pairing, and refused otherwise — even
// if some other chain would have made Chromium happy. Origins that are not
// pinned get Chromium's own verdict, exactly as before.
//
// `probe` reads the fingerprint a never-seen host presents, for the typed
// pairing where no QR carried it; it trusts nothing (rejectUnauthorized is
// off only for that one handshake, and no request is made on it).

import { X509Certificate } from 'node:crypto';
import { connect } from 'node:tls';

/** Chromium's verify-proc results. */
export const VERDICT = Object.freeze({ accept: 0, reject: -2, chromium: -3 });

/** The SHA-256 of a PEM certificate as the host prints it: 64 lowercase hex. */
export function fingerprintOfPem(pem) {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

export function originKey(hostname, port) {
  return `${String(hostname).toLowerCase()}:${Number(port)}`;
}

/** A tiny pin table: origin key → fingerprint. */
export function createPinStore() {
  const pins = new Map();
  return {
    pin(origin, fingerprint) {
      const url = new URL(origin);
      pins.set(originKey(url.hostname, url.port || 443), String(fingerprint).toLowerCase());
    },
    clear() { pins.clear(); },
    /** @param {{ hostname: string, port?: number, certificate: { data: string } }} request */
    decide(request) {
      const expected = pins.get(originKey(request.hostname, request.port ?? 443));
      if (!expected) return VERDICT.chromium;
      let actual;
      try { actual = fingerprintOfPem(request.certificate.data); } catch { return VERDICT.reject; }
      return actual === expected ? VERDICT.accept : VERDICT.reject;
    },
    size: () => pins.size,
  };
}

/** The leaf fingerprint `origin` presents, or a rejection when nothing does. */
export function probeFingerprint(origin, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(origin); } catch { reject(new Error('not a URL')); return; }
    if (url.protocol !== 'https:') { reject(new Error('probe needs an https origin')); return; }
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      const fp = cert?.fingerprint256;
      if (!fp) { reject(new Error('no certificate was presented')); return; }
      resolve(fp.replace(/:/g, '').toLowerCase());
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('timed out')); });
    socket.on('error', reject);
  });
}
