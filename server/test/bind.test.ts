// BELAY_BIND: which interfaces the host listens on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBind, bindBannerLine, LOOPBACK } from '../src/bind.js';

const interfaces = [
  { address: '192.168.1.20', interfaceName: 'en0' },
  { address: '100.101.102.103', interfaceName: 'utun4' },
];

test('the default is every interface, so LAN pairing keeps working', () => {
  for (const setting of [undefined, '', 'all', 'ALL', '0.0.0.0', '::']) {
    assert.deepEqual(resolveBind(setting, interfaces), { setting: 'all', hosts: [] }, String(setting));
  }
  assert.equal(bindBannerLine(resolveBind(undefined, interfaces)), 'all interfaces');
});

test('tailnet binds loopback plus the Tailscale address only', () => {
  assert.deepEqual(resolveBind('tailnet', interfaces), {
    setting: 'tailnet',
    hosts: [LOOPBACK, '100.101.102.103'],
  });
  assert.equal(bindBannerLine(resolveBind('tailnet', interfaces)), 'tailnet (127.0.0.1, 100.101.102.103)');
});

test('tailnet without a Tailscale interface falls to loopback, never open', () => {
  // An ISP CGNAT address on a physical interface is not Tailscale.
  const lanOnly = [
    { address: '192.168.1.20', interfaceName: 'en0' },
    { address: '100.70.1.2', interfaceName: 'en0' },
  ];
  const bind = resolveBind('tailnet', lanOnly);
  assert.deepEqual(bind.hosts, [LOOPBACK]);
  assert.match(bind.warning ?? '', /no Tailscale interface/);
  assert.match(bindBannerLine(bind), /127\.0\.0\.1.*no Tailscale interface/);
});

test('explicit addresses are used as given, de-duplicated', () => {
  assert.deepEqual(resolveBind('127.0.0.1, 192.168.1.20,127.0.0.1', interfaces).hosts, ['127.0.0.1', '192.168.1.20']);
  assert.equal(bindBannerLine(resolveBind('127.0.0.1', interfaces)), '127.0.0.1 (127.0.0.1)');
});
