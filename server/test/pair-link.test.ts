// Unit tests for the pairing link carried in the QR code.
//
// The parser is a security boundary: its input is whatever a camera decoded,
// which could be any QR code in the world.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPairLink, parsePairLink, PAIR_LINK_VERSION } from '../src/pair-link.js';
import { HostAddress } from '../src/addresses.js';

const addresses: HostAddress[] = [
  { kind: 'lan', url: 'http://192.168.1.5:8787' },
  { kind: 'tailscale', url: 'http://100.101.102.103:8787' },
];

const input = {
  hostId: 'da771aad-caa5-4be3-bbbc-01ae4a36d02b',
  label: 'MacBook Air',
  platform: 'darwin',
  code: '472234',
  addresses,
};

test('a built link round-trips through the parser', () => {
  const parsed = parsePairLink(buildPairLink(input));
  assert.ok(parsed);
  assert.equal(parsed.hostId, input.hostId);
  assert.equal(parsed.label, 'MacBook Air');
  assert.equal(parsed.platform, 'darwin');
  assert.equal(parsed.code, '472234');
  assert.deepEqual(parsed.addresses, addresses.map((a) => a.url));
});

test('every address rides along, so the phone can race them later', () => {
  const link = buildPairLink(input);
  assert.equal((link.match(/[?&]a=/g) ?? []).length, 2);
});

test('a label with spaces and punctuation survives', () => {
  const parsed = parsePairLink(buildPairLink({ ...input, label: "Moss's MacBook (work)" }));
  assert.equal(parsed?.label, "Moss's MacBook (work)");
});

test('the link never contains a token', () => {
  // It carries the pairing code, which is single-use and expiring, so
  // photographing the screen is exactly as powerful as reading the code off it.
  const link = buildPairLink(input);
  assert.ok(!/token/i.test(link));
});

test('unrelated QR codes are rejected rather than throwing', () => {
  const junk = [
    '', '   ', 'hello world',
    'https://example.com',
    'WIFI:S:MyNetwork;T:WPA;P:hunter2;;',
    'mailto:someone@example.com',
    'tel:+15551234',
    '{"not":"a url"}',
    'tether://something-else?v=1',
  ];
  for (const raw of junk) {
    assert.equal(parsePairLink(raw), null, `${raw} must not parse`);
  }
});

test('a link from a future version is refused', () => {
  const link = buildPairLink(input).replace(`v=${PAIR_LINK_VERSION}`, 'v=99');
  assert.equal(parsePairLink(link), null);
});

test('a link missing required fields is refused', () => {
  const base = buildPairLink(input);
  assert.equal(parsePairLink(base.replace(/id=[^&]*/, 'id=')), null, 'no host id');
  assert.equal(parsePairLink(base.replace(/c=\d{6}/, 'c=')), null, 'no code');
  assert.equal(parsePairLink(base.replace(/[?&]a=[^&]*/g, '')), null, 'no addresses');
});

test('a malformed code is refused', () => {
  const base = buildPairLink(input);
  for (const bad of ['12345', '1234567', 'abcdef', '12 34 56']) {
    const link = base.replace(/c=\d{6}/, `c=${encodeURIComponent(bad)}`);
    assert.equal(parsePairLink(link), null, `code ${bad} must not parse`);
  }
});

test('non-http addresses are dropped', () => {
  // A crafted QR must not be able to point the app at another scheme and have
  // it send a pairing request — and later a bearer token — wherever it names.
  const hostile = buildPairLink({
    ...input,
    addresses: [
      { kind: 'lan', url: 'file:///etc/passwd' },
      { kind: 'lan', url: 'javascript:alert(1)' },
      { kind: 'lan', url: 'http://192.168.1.5:8787' },
    ],
  });
  const parsed = parsePairLink(hostile);
  assert.ok(parsed);
  assert.deepEqual(parsed.addresses, ['http://192.168.1.5:8787']);
});

test('a link with only non-http addresses is refused entirely', () => {
  const link = buildPairLink({
    ...input,
    addresses: [{ kind: 'lan', url: 'file:///etc/passwd' }],
  });
  assert.equal(parsePairLink(link), null);
});

test('surrounding whitespace from a scan is tolerated', () => {
  const parsed = parsePairLink(`  ${buildPairLink(input)}\n`);
  assert.ok(parsed);
});

test('a host with no addresses produces a link that will not parse', () => {
  // Better to refuse than to hand the phone a code it has nowhere to send.
  assert.equal(parsePairLink(buildPairLink({ ...input, addresses: [] })), null);
});
