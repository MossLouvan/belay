// Code-less pairing over Tailscale: the pure parts. The CLI itself is not run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIp, couldBeTailnet, parseWhois, parseSelfLogin, tailnetTrusted, tailnetPairingEnabled,
} from '../src/tailnet.js';

test('normalizeIp strips the IPv4-mapped prefix Node reports on dual-stack sockets', () => {
  assert.equal(normalizeIp('::ffff:100.101.102.103'), '100.101.102.103');
  assert.equal(normalizeIp('100.101.102.103'), '100.101.102.103');
  assert.equal(normalizeIp(undefined), '');
});

test('only CGNAT / Tailscale-ULA sources can be tailnet peers', () => {
  assert.equal(couldBeTailnet('100.101.102.103'), true);
  assert.equal(couldBeTailnet('::ffff:100.64.0.7'), true);
  assert.equal(couldBeTailnet('fd7a:115c:a1e0::1'), true);
  assert.equal(couldBeTailnet('192.168.1.20'), false);
  assert.equal(couldBeTailnet('127.0.0.1'), false);
  assert.equal(couldBeTailnet(undefined), false);
});

test('parseWhois reads login and node name, and rejects anything without a login', () => {
  const ok = parseWhois(JSON.stringify({
    Node: { Name: 'moss-iphone.tail1234.ts.net.' },
    UserProfile: { LoginName: 'moss@example.com' },
  }));
  assert.deepEqual(ok, { login: 'moss@example.com', node: 'moss-iphone.tail1234.ts.net.' });
  assert.equal(parseWhois('{}'), null);
  assert.equal(parseWhois('not json'), null);
  assert.equal(parseWhois(JSON.stringify({ UserProfile: { LoginName: '' } })), null);
});

test('parseSelfLogin joins Self.UserID to the User table', () => {
  const status = JSON.stringify({
    Self: { UserID: 12345 },
    User: { '12345': { LoginName: 'moss@example.com' }, '999': { LoginName: 'someone@else.com' } },
  });
  assert.equal(parseSelfLogin(status), 'moss@example.com');
  assert.equal(parseSelfLogin(JSON.stringify({ Self: {}, User: {} })), null);
  assert.equal(parseSelfLogin('nope'), null);
});

test('a non-tailnet source is refused without ever consulting the CLI', async () => {
  // This must be fast and must not depend on tailscale being installed.
  const started = Date.now();
  assert.deepEqual(await tailnetTrusted('192.168.1.20'), { trusted: false });
  assert.deepEqual(await tailnetTrusted('::ffff:10.0.0.7'), { trusted: false });
  assert.ok(Date.now() - started < 500);
});

test('DESKHANDLER_TAILNET_PAIR=0 switches the feature off', async () => {
  const prev = process.env.DESKHANDLER_TAILNET_PAIR;
  process.env.DESKHANDLER_TAILNET_PAIR = '0';
  try {
    assert.equal(tailnetPairingEnabled(), false);
    assert.deepEqual(await tailnetTrusted('100.101.102.103'), { trusted: false });
  } finally {
    if (prev === undefined) delete process.env.DESKHANDLER_TAILNET_PAIR; else process.env.DESKHANDLER_TAILNET_PAIR = prev;
  }
});
