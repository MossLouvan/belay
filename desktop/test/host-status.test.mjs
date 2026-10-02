import assert from 'node:assert/strict';
import { test } from 'node:test';

import { livePairing, loginItemAfterHealth, pairingFromMessage, parsePairing, qrSvg, readHealth, statusLine } from '../src/host-status.js';

test('parsePairing reads the code and identity, both schemes, rejects the rest', () => {
  const link = 'belay://pair?v=1&id=abc&n=Studio&p=darwin&c=123456&a=https%3A%2F%2F10.0.0.2%3A8787';
  assert.deepEqual(parsePairing(link), { code: '123456', hostId: 'abc', label: 'Studio' });
  assert.equal(parsePairing(link.replace('belay:', 'tether:'))?.code, '123456');
  assert.equal(parsePairing('belay://pair?c=12'), null);
  assert.equal(parsePairing('https://example.com/pair?c=123456'), null);
  assert.equal(parsePairing(undefined), null);
});

// Belay.app shows the account claim QR while the computer is unlinked: its
// code is the 8-character one the phone's "type the code" field takes.
test('parsePairing reads the claim code from a claim link', () => {
  const node = 'ab'.repeat(32);
  assert.deepEqual(parsePairing(`belay://claim?c=ABCD2345&n=${node}`), { code: 'ABCD2345', hostId: node, label: '' });
  assert.equal(parsePairing(`belay://claim?c=12345678&n=${node}`), null);
});

test('qrSvg draws one unit square per dark module inside a quiet zone', () => {
  const svg = qrSvg([[true, false], [false, true]], { quiet: 1 });
  assert.match(svg, /viewBox="0 0 4 4"/);
  assert.match(svg, /M1 1h1v1h-1z/);
  assert.match(svg, /M2 2h1v1h-1z/);
  assert.doesNotMatch(svg, /M2 1h1v1h-1z/);
  assert.equal(qrSvg([]), '');
});

test('statusLine counts phones and names the port clash', () => {
  assert.equal(statusLine({ phase: 'running', devices: 0, port: 8787 }), 'Running · not linked yet');
  assert.equal(statusLine({ phase: 'running', devices: 1, port: 8787 }), 'Running · 1 phone');
  assert.equal(statusLine({ phase: 'running', devices: 3, port: 8787 }), 'Running · 3 phones');
  assert.equal(statusLine({ phase: 'busy', port: 8787 }), 'Belay is already running on port 8787');
  assert.equal(statusLine({ phase: 'starting', port: 8787 }), 'Starting…');
});

test('login item turns on by itself only once, on the first link', () => {
  const fresh = {};
  assert.equal(loginItemAfterHealth(fresh, false), fresh);
  assert.deepEqual(loginItemAfterHealth(fresh, true), { openAtLogin: true });
  const optedOut = { openAtLogin: false };
  assert.equal(loginItemAfterHealth(optedOut, true), optedOut);
});

test('readHealth accepts the host shape and falls back for older hosts', () => {
  assert.deepEqual(readHealth({ ok: true, id: 'x', devices: 2, native: true, paired: true, name: 'mac' }),
    { devices: 2, native: true, paired: true, name: 'mac' });
  assert.equal(readHealth({ ok: true, id: 'x', paired: true }).devices, 1);
  assert.equal(readHealth({ ok: true }), null);
  assert.equal(readHealth(null), null);
});

// ---- a code on demand, shown while paired (#150) ----------------------------

const LINK = 'belay://pair?v=1&id=abc&n=Studio&p=darwin&c=123456';

test('pairingFromMessage keeps the link, the QR and when the code dies', () => {
  const p = pairingFromMessage({ type: 'pairing', link: LINK, modules: [[true]], expiresInSec: 120 }, 1_000);
  assert.deepEqual(p, { link: LINK, modules: [[true]], expiresAt: 121_000 });
});

test('pairingFromMessage falls back to the five-minute window for an older host', () => {
  assert.equal(pairingFromMessage({ type: 'pairing', link: LINK, modules: [] }, 0)?.expiresAt, 300_000);
});

test('pairingFromMessage rejects anything malformed', () => {
  assert.equal(pairingFromMessage({ type: 'pairing', link: 5, modules: [] }, 0), null);
  assert.equal(pairingFromMessage({ type: 'pairing', link: LINK }, 0), null);
  assert.equal(pairingFromMessage(null, 0), null);
});

test('livePairing hides a code once it has expired', () => {
  const p = pairingFromMessage({ type: 'pairing', link: LINK, modules: [], expiresInSec: 120 }, 0);
  assert.equal(livePairing(p, 119_999), p);
  assert.equal(livePairing(p, 120_000), null);
  assert.equal(livePairing(null, 0), null);
});
