// Unit tests for address discovery and classification.
//
// The property that matters most: a computer must never end up advertising
// only LAN addresses without that being detectable, because a LAN-only device
// cannot be re-found from outside the house after its IP changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTailscaleAddress, buildAddresses, hasStableAddress, HostAddress,
} from '../src/addresses.js';

test('isTailscaleAddress recognises the CGNAT range', () => {
  assert.equal(isTailscaleAddress('100.64.0.0'), true, 'first address in range');
  assert.equal(isTailscaleAddress('100.101.102.103'), true, 'typical tailscale IP');
  assert.equal(isTailscaleAddress('100.127.255.255'), true, 'last address in range');
});

test('isTailscaleAddress rejects addresses outside the range', () => {
  // 100.0.0.0/8 is *not* all CGNAT — only 100.64.0.0/10 is. A naive
  // startsWith('100.') check gets these wrong.
  assert.equal(isTailscaleAddress('100.63.255.255'), false, 'just below the range');
  assert.equal(isTailscaleAddress('100.128.0.1'), false, 'just above the range');
  assert.equal(isTailscaleAddress('100.0.0.1'), false, 'public 100.x, not CGNAT');
  assert.equal(isTailscaleAddress('192.168.1.5'), false);
  assert.equal(isTailscaleAddress('10.0.0.1'), false);
});

test('isTailscaleAddress rejects malformed input rather than throwing', () => {
  for (const bad of ['', 'not-an-ip', '100.64.0', '100.64.0.0.1', '999.1.1.1', '100.64.0.x']) {
    assert.equal(isTailscaleAddress(bad), false, `${bad} must not be treated as tailscale`);
  }
});

test('buildAddresses classifies LAN and tailscale IPs', () => {
  const addresses = buildAddresses(8787, [], ['192.168.1.5', '100.101.102.103']);
  const lan = addresses.find((a) => a.url === 'http://192.168.1.5:8787');
  const ts = addresses.find((a) => a.url === 'http://100.101.102.103:8787');

  assert.equal(lan?.kind, 'lan');
  assert.equal(ts?.kind, 'tailscale');
});

test('buildAddresses uses the port it is given', () => {
  const addresses = buildAddresses(9000, [], ['192.168.1.5']);
  assert.equal(addresses[0].url, 'http://192.168.1.5:9000');
});

test('buildAddresses merges extra addresses and lets them win on conflict', () => {
  // A sidecar reporting a MagicDNS name must be able to override the
  // classification we inferred from the raw interface address.
  const extra: HostAddress[] = [
    { kind: 'magicdns', url: 'http://mac.tailnet.ts.net:8787' },
    { kind: 'magicdns', url: 'http://100.101.102.103:8787' },
  ];
  const addresses = buildAddresses(8787, extra, ['100.101.102.103']);

  const overridden = addresses.find((a) => a.url === 'http://100.101.102.103:8787');
  assert.equal(overridden?.kind, 'magicdns', 'explicit report beats inference');
  assert.ok(addresses.some((a) => a.url === 'http://mac.tailnet.ts.net:8787'));
});

test('buildAddresses does not emit duplicates', () => {
  const addresses = buildAddresses(8787, [], ['192.168.1.5', '192.168.1.5']);
  assert.equal(addresses.length, 1);
});

test('buildAddresses orders LAN first, then stable kinds', () => {
  const addresses = buildAddresses(
    8787,
    [{ kind: 'relay', url: 'http://relay/x' }, { kind: 'magicdns', url: 'http://m.ts.net:8787' }],
    ['100.101.102.103', '192.168.1.5'],
  );
  assert.deepEqual(addresses.map((a) => a.kind), ['lan', 'magicdns', 'tailscale', 'relay']);
});

test('buildAddresses on a machine with no interfaces returns nothing rather than throwing', () => {
  assert.deepEqual(buildAddresses(8787, [], []), []);
});

test('hasStableAddress is false for a LAN-only host', () => {
  const addresses = buildAddresses(8787, [], ['192.168.1.5', '10.0.0.7']);
  assert.equal(hasStableAddress(addresses), false);
});

test('hasStableAddress is true once any non-LAN path exists', () => {
  assert.equal(hasStableAddress(buildAddresses(8787, [], ['100.64.1.1'])), true);
  assert.equal(
    hasStableAddress(buildAddresses(8787, [{ kind: 'relay', url: 'http://r/1' }], ['192.168.1.5'])),
    true,
  );
});

test('hasStableAddress is false for an empty list', () => {
  assert.equal(hasStableAddress([]), false);
});
