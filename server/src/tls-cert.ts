// The host's TLS identity: a self-signed certificate minted once and kept
// beside the state file, so the phone and desktop clients can pin its
// fingerprint at pairing and refuse anything else on the LAN.
//
// Why self-signed and hand-rolled: a home LAN host has no domain name and
// cannot answer an ACME challenge, so a publicly trusted certificate is not
// on the table, and Node ships no certificate *writer* — only a parser. The
// certificate is nothing but a signed envelope around a public key, and the
// clients never chain-validate it (they compare the SHA-256 of the DER to the
// fingerprint they were handed at pairing), so a minimal X.509 v3 encoder is
// all that is needed: no extensions, no SAN, no CA flag. Anything more would
// be asserting trust properties nobody checks.
//
// The private key never leaves this file's directory and is written 0600,
// exactly like the device tokens it now protects in transit.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TLS_KEY_FILE = 'belay-tls-key.pem';
export const TLS_CERT_FILE = 'belay-tls-cert.pem';
const FILE_MODE = 0o600;
/** Ten years. Clients pin the fingerprint, so rotation means re-pairing. */
const VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface TlsIdentity {
  readonly key: string;
  readonly cert: string;
  /** SHA-256 of the certificate DER, lowercase hex, no separators. */
  readonly fingerprint: string;
}

// ---- DER ------------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));

/** A positive INTEGER: a leading zero keeps the high bit from reading as sign. */
function integer(bytes: Buffer): Buffer {
  return tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function utcTime(at: Date): Buffer {
  // YYMMDDHHMMSSZ — valid for years 1950–2049, which covers this certificate.
  const s = at.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/** ecdsa-with-SHA256 (1.2.840.10045.4.3.2), no parameters. */
const ECDSA_SHA256 = sequence(Buffer.from('06082a8648ce3d040302', 'hex'));
/** commonName (2.5.4.3). */
const CN_OID = Buffer.from('0603550403', 'hex');

function name(commonName: string): Buffer {
  return sequence(set(sequence(CN_OID, tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

/**
 * Encode a self-signed X.509 v3 certificate for `privateKey`.
 *
 * Exported for the test, which parses the result with Node's own X509 parser
 * and verifies the signature — the one check that proves the encoder right.
 */
export function selfSignedCertificate(privateKey: KeyObject, now = new Date()): Buffer {
  const subject = name('Belay host');
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] EXPLICIT version v3
    integer(randomBytes(16)),
    ECDSA_SHA256,
    subject,
    sequence(utcTime(now), utcTime(new Date(now.getTime() + VALIDITY_MS))),
    subject,
    spki,
  );
  const signature = sign('sha256', tbs, privateKey);
  return sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

function toPem(label: string, der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Fingerprint as the clients compare it: lowercase hex, no colons. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** The fingerprint as a person reads it off a screen: 8 groups of 8. */
export function displayFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,8}/g) ?? []).join(' ').toUpperCase();
}

/**
 * Load the identity from `dir`, minting it on first run.
 *
 * Both files are written 0600 and re-asserted on every load, for the same
 * reason state.ts does it: an older file may predate the mode. A key or
 * certificate that fails to parse is regenerated rather than served — a host
 * that cannot start TLS is a host nobody can pair with.
 */
export function ensureTlsIdentity(dir: string, log: (line: string) => void = console.log): TlsIdentity {
  const keyPath = join(dir, TLS_KEY_FILE);
  const certPath = join(dir, TLS_CERT_FILE);
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const key = readFileSync(keyPath, 'utf8');
      const cert = readFileSync(certPath, 'utf8');
      createPrivateKey(key);
      const fingerprint = fingerprintOf(cert);
      for (const p of [keyPath, certPath]) chmodSync(p, FILE_MODE);
      return { key, cert, fingerprint };
    } catch (e: unknown) {
      log(`[tls] ${keyPath} or ${certPath} is unreadable (${e instanceof Error ? e.message : String(e)}); ` +
        'minting a new certificate — every paired device must pair again.');
    }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const cert = toPem('CERTIFICATE', selfSignedCertificate(privateKey));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, key, { mode: FILE_MODE });
  writeFileSync(certPath, cert, { mode: FILE_MODE });
  log(`[tls] minted a new host certificate in ${dir}`);
  return { key, cert, fingerprint: fingerprintOf(cert) };
}
