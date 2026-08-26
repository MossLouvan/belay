// Unit tests for address discovery and classification.
//
// The property that matters most: a computer must never end up advertising
// only LAN addresses without that being detectable, because a LAN-only device
// cannot be re-found from outside the house after its IP changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTailscaleAddress, isCgnatAddress, isTunnelInterface, buildAddresses,
  hasStableAddress, HostAddress, LocalAddress,
} from '../src/addresses.js';

/** Shorthand for an address found on a given interface. */
const on = (address: string, interfaceName: string): LocalAddress => ({ address, interfaceName });

test('isCgnatAddress recognises the CGNAT range', () => {
  assert.equal(isCgnatAddress('100.64.0.0'), true, 'first address in range');
  assert.equal(isCgnatAddress('100.101.102.103'), true, 'typical CGNAT IP');
  assert.equal(isCgnatAddress('100.127.255.255'), true, 'last address in range');
});

test('isCgnatAddress rejects addresses outside the range', () => {
  // 100.0.0.0/8 is *not* all CGNAT — only 100.64.0.0/10 is. A naive
  // startsWith('100.') check gets these wrong.
  assert.equal(isCgnatAddress('100.63.255.255'), false, 'just below the range');
  assert.equal(isCgnatAddress('100.128.0.1'), false, 'just above the range');
  assert.equal(isCgnatAddress('100.0.0.1'), false, 'public 100.x, not CGNAT');
  assert.equal(isCgnatAddress('192.168.1.5'), false);
  assert.equal(isCgnatAddress('10.0.0.1'), false);
});

test('isCgnatAddress rejects malformed input rather than throwing', () => {
  for (const bad of ['', 'not-an-ip', '100.64.0', '100.64.0.0.1', '999.1.1.1', '100.64.0.x']) {
    assert.equal(isCgnatAddress(bad), false, `${bad} must not be treated as CGNAT`);
  }
});

test('isTunnelInterface knows a tunnel from a physical adapter', () => {
  for (const name of ['utun0', 'utun4', 'tailscale0', 'ts0']) {
    assert.equal(isTunnelInterface(name), true, `${name} is a tunnel`);
  }
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', 'lo0', 'bridge100']) {
    assert.equal(isTunnelInterface(name), false, `${name} is physical`);
  }
});

test('an ISP CGNAT address on Wi-Fi is NOT Tailscale', () => {
  // Observed in practice: a Mac with no Tailscale installed had 100.68.229.206
  // on en0, handed out by the ISP. Calling that Tailscale made the host claim
  // it was reachable from anywhere when the truth is the opposite — behind
  // CGNAT there is no public address and nothing to port-forward.
  assert.equal(isTailscaleAddress('100.68.229.206', 'en0'), false);
  assert.equal(isCgnatAddress('100.68.229.206'), true, 'still in the range, though');
});

test('a CGNAT address on a tunnel interface is Tailscale', () => {
  assert.equal(isTailscaleAddress('100.101.102.103', 'utun3'), true);
  assert.equal(isTailscaleAddress('100.101.102.103', 'tailscale0'), true);
});

test('a private address on a tunnel is still not Tailscale', () => {
  // A corporate VPN also creates a utun; only the CGNAT range is Tailscale's.
  assert.equal(isTailscaleAddress('10.8.0.2', 'utun1'), false);
});

test('buildAddresses classifies LAN and tailscale IPs', () => {
  const addresses = buildAddresses(8787, [], [on('192.168.1.5', 'en0'), on('100.101.102.103', 'utun3')]);
  const lan = addresses.find((a) => a.url === 'http://192.168.1.5:8787');
  const ts = addresses.find((a) => a.url === 'http://100.101.102.103:8787');

  assert.equal(lan?.kind, 'lan');
  assert.equal(ts?.kind, 'tailscale');
});

test('buildAddresses uses the port it is given', () => {
  const addresses = buildAddresses(9000, [], [on('192.168.1.5', 'en0')]);
  assert.equal(addresses[0].url, 'http://192.168.1.5:9000');
});

test('buildAddresses merges extra addresses and lets them win on conflict', () => {
  // A sidecar reporting a MagicDNS name must be able to override the
  // classification we inferred from the raw interface address.
  const extra: HostAddress[] = [
    { kind: 'magicdns', url: 'http://mac.tailnet.ts.net:8787' },
    { kind: 'magicdns', url: 'http://100.101.102.103:8787' },
  ];
  const addresses = buildAddresses(8787, extra, [on('100.101.102.103', 'utun3')]);

  const overridden = addresses.find((a) => a.url === 'http://100.101.102.103:8787');
  assert.equal(overridden?.kind, 'magicdns', 'explicit report beats inference');
  assert.ok(addresses.some((a) => a.url === 'http://mac.tailnet.ts.net:8787'));
});

test('buildAddresses does not emit duplicates', () => {
  const addresses = buildAddresses(8787, [], [on('192.168.1.5', 'en0'), on('192.168.1.5', 'en0')]);
  assert.equal(addresses.length, 1);
});

test('buildAddresses orders LAN first, then stable kinds', () => {
  const addresses = buildAddresses(
    8787,
    [{ kind: 'relay', url: 'http://relay/x' }, { kind: 'magicdns', url: 'http://m.ts.net:8787' }],
    [on('100.101.102.103', 'utun3'), on('192.168.1.5', 'en0')],
  );
  assert.deepEqual(addresses.map((a) => a.kind), ['lan', 'magicdns', 'tailscale', 'relay']);
});

test('buildAddresses on a machine with no interfaces returns nothing rather than throwing', () => {
  assert.deepEqual(buildAddresses(8787, [], []), []);
});

test('hasStableAddress is false for a LAN-only host', () => {
  const addresses = buildAddresses(8787, [], [on('192.168.1.5', 'en0'), on('10.0.0.7', 'en1')]);
  assert.equal(hasStableAddress(addresses), false);
});

test('hasStableAddress is true once any non-LAN path exists', () => {
  assert.equal(hasStableAddress(buildAddresses(8787, [], [on('100.64.1.1', 'utun3')])), true);
  assert.equal(
    hasStableAddress(buildAddresses(8787, [{ kind: 'relay', url: 'http://r/1' }], [on('192.168.1.5', 'en0')])),
    true,
  );
});

test('hasStableAddress is false for an empty list', () => {
  assert.equal(hasStableAddress([]), false);
});

test('a host behind ISP CGNAT is not reported as reachable from anywhere', () => {
  // The exact situation on the owner's Mac: one address, 100.x, on en0.
  const addresses = buildAddresses(8787, [], [on('100.68.229.206', 'en0')]);
  assert.equal(addresses[0].kind, 'lan', 'classified as local, not tailscale');
  assert.equal(hasStableAddress(addresses), false, 'must not promise remote reachability');
});
