import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loginItemAfterHealth, parsePairing, qrSvg, readHealth, statusLine } from '../src/host-status.js';

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
