// Code-less pairing over Tailscale: the pure parts. The CLI itself is not run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIp, couldBeTailnet, parseWhois, parseSelf, parseSelfLogin, samePerson, tailnetTrusted,
  tailnetPairingEnabled,
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
  assert.deepEqual(ok, { login: 'moss@example.com', node: 'moss-iphone.tail1234.ts.net.', userId: '', tagged: false });
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

test('BELAY_TAILNET_PAIR=0 switches the feature off', async () => {
  const prev = process.env.BELAY_TAILNET_PAIR;
  process.env.BELAY_TAILNET_PAIR = '0';
  try {
    assert.equal(tailnetPairingEnabled(), false);
    assert.deepEqual(await tailnetTrusted('100.101.102.103'), { trusted: false });
  } finally {
    if (prev === undefined) delete process.env.BELAY_TAILNET_PAIR; else process.env.BELAY_TAILNET_PAIR = prev;
  }
});

const me = { login: 'moss@example.com', userId: '12345' };
const peerOf = (login: string, userId: string, tagged = false) => ({ login, node: '', userId, tagged });

test('parseWhois carries the stable user id and flags tagged nodes', () => {
  const peer = parseWhois(JSON.stringify({
    Node: { Name: 'phone.ts.net.', Tags: [] },
    UserProfile: { ID: 12345, LoginName: 'moss@example.com' },
  }));
  assert.deepEqual(peer, { login: 'moss@example.com', node: 'phone.ts.net.', userId: '12345', tagged: false });
  const tagged = parseWhois(JSON.stringify({
    Node: { Name: 'ci-box.ts.net.', Tags: ['tag:ci'] },
    UserProfile: { ID: 1, LoginName: 'tagged-devices' },
  }));
  assert.equal(tagged?.tagged, true);
  const tagsOnly = parseWhois(JSON.stringify({
    Node: { Tags: ['tag:server'] }, UserProfile: { ID: 12345, LoginName: 'moss@example.com' },
  }));
  assert.equal(tagsOnly?.tagged, true);
});

test('parseSelf returns login and user id together', () => {
  assert.deepEqual(parseSelf(JSON.stringify({
    Self: { UserID: 12345 }, User: { '12345': { LoginName: 'moss@example.com' } },
  })), me);
  assert.equal(parseSelf(JSON.stringify({ Self: { UserID: 7 }, User: {} })), null);
});

test('tagged nodes never pair without a code, whatever their login says', () => {
  const taggedPeer = peerOf('tagged-devices', '1', true);
  assert.equal(samePerson(me, taggedPeer), false);
  // A tagged host and a tagged peer share the placeholder login; still no.
  assert.equal(samePerson({ login: 'tagged-devices', userId: '1' }, taggedPeer), false);
  assert.equal(samePerson({ login: 'tagged-devices', userId: '1' }, peerOf('tagged-devices', '1')), false);
  // Tags on the node are enough even when the login looks like a person.
  assert.equal(samePerson(me, peerOf('moss@example.com', '12345', true)), false);
  assert.equal(samePerson(me, peerOf('', '12345')), false);
});

test('the user id decides when both sides report one; the login is the fallback', () => {
  // A node shared in from another tailnet: same-looking login, different id.
  assert.equal(samePerson(me, peerOf('moss@example.com', '999')), false);
  assert.equal(samePerson(me, peerOf('Moss@Example.com', '12345')), true);
  // Older CLI without ids: case-insensitive login match, as before.
  assert.equal(samePerson({ login: 'moss@example.com', userId: '' }, peerOf('MOSS@example.com', '')), true);
  assert.equal(samePerson(me, peerOf('other@example.com', '')), false);
});
