// Unit tests for the scanned pairing link.
//
//   cd app && node --test src/connect/pair-link.test.mjs
//
// These mirror server/test/pair-link.test.ts on purpose: the parser is
// duplicated across the two packages, so both suites cover the same cases and
// any drift between them shows up as a failure rather than as a QR that
// scans on one side and not the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePairLink } from './pair-link.ts';

const LINK =
  'belay://pair?v=1&id=da771aad-caa5-4be3-bbbc-01ae4a36d02b&n=MacBook+Air&p=darwin' +
  '&c=472234&a=http%3A%2F%2F192.168.1.5%3A8787&a=http%3A%2F%2F100.101.102.103%3A8787';

test('a well-formed link parses', () => {
  const parsed = parsePairLink(LINK);
  assert.ok(parsed);
  assert.equal(parsed.hostId, 'da771aad-caa5-4be3-bbbc-01ae4a36d02b');
  assert.equal(parsed.label, 'MacBook Air');
  assert.equal(parsed.platform, 'darwin');
  assert.equal(parsed.code, '472234');
  assert.deepEqual(parsed.addresses, [
    'http://192.168.1.5:8787',
    'http://100.101.102.103:8787',
  ]);
});

test('a pre-rename tether:// link still parses', () => {
  // QR codes printed before the rename to Belay are out in the world —
  // taped to a monitor, saved in a photo roll — and must keep pairing phones.
  const parsed = parsePairLink(LINK.replace(/^belay:/, 'tether:'));
  assert.ok(parsed);
  assert.equal(parsed.code, '472234');
});

test('every advertised address is kept, so they can be raced', () => {
  // The LAN address is useless on cellular and the Tailscale one is useless
  // without Tailscale running — the phone needs all of them to find the one
  // that works from where it is standing.
  assert.equal(parsePairLink(LINK).addresses.length, 2);
});

test('unrelated QR codes return null instead of throwing', () => {
  const junk = [
    '', '   ', 'hello world',
    'https://example.com',
    'WIFI:S:MyNetwork;T:WPA;P:hunter2;;',
    'mailto:someone@example.com',
    'tel:+15551234',
    '{"not":"a url"}',
    'belay://something-else?v=1',
    'tether://something-else?v=1',
  ];
  for (const raw of junk) {
    assert.equal(parsePairLink(raw), null, `${raw} must not parse`);
  }
});

test('a future version is refused rather than half-understood', () => {
  assert.equal(parsePairLink(LINK.replace('v=1', 'v=99')), null);
});

test('missing required fields are refused', () => {
  assert.equal(parsePairLink(LINK.replace(/id=[^&]*/, 'id=')), null, 'no host id');
  assert.equal(parsePairLink(LINK.replace('c=472234', 'c=')), null, 'no code');
  assert.equal(parsePairLink(LINK.replace(/&a=[^&]*/g, '')), null, 'no addresses');
});

test('a malformed code is refused', () => {
  for (const bad of ['12345', '1234567', 'abcdef']) {
    assert.equal(parsePairLink(LINK.replace('c=472234', `c=${bad}`)), null, `code ${bad}`);
  }
});

test('non-http addresses are dropped', () => {
  // A crafted QR must not be able to name another scheme and have the app send
  // a pairing request — and shortly a bearer token — wherever it points.
  const hostile = LINK + '&a=' + encodeURIComponent('file:///etc/passwd')
                       + '&a=' + encodeURIComponent('javascript:alert(1)');
  const parsed = parsePairLink(hostile);
  assert.deepEqual(parsed.addresses, [
    'http://192.168.1.5:8787',
    'http://100.101.102.103:8787',
  ]);
});

test('a link with only non-http addresses is refused entirely', () => {
  const link = LINK.replace(/&a=[^&]*/g, '') + '&a=' + encodeURIComponent('file:///etc/passwd');
  assert.equal(parsePairLink(link), null);
});

test('whitespace around a scan result is tolerated', () => {
  assert.ok(parsePairLink(`  ${LINK}\n`));
});

test('a label falls back when absent', () => {
  assert.equal(parsePairLink(LINK.replace('n=MacBook+Air', 'n=')).label, 'My computer');
});
