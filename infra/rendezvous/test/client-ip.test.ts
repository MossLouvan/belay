// Client-IP derivation behind a trusted proxy: the key rate limiting depends
// on. The two load-bearing properties are pinned exactly — proxied clients get
// separate buckets, and a spoofed XFF from an untrusted peer is ignored.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTrustedProxies, deriveClientIp } from '../src/client-ip.js';

test('default (no trusted proxies) keys on the socket peer and ignores XFF', () => {
  const trusted = parseTrustedProxies(undefined);
  assert.equal(trusted.size, 0);
  // Even a present XFF is ignored: nobody is trusted to set it.
  assert.equal(deriveClientIp('203.0.113.9', '1.2.3.4', trusted), '203.0.113.9');
});

test('behind a trusted proxy, distinct clients get distinct keys (separate buckets)', () => {
  const trusted = parseTrustedProxies('10.0.0.1');
  const a = deriveClientIp('10.0.0.1', '198.51.100.7', trusted);
  const b = deriveClientIp('10.0.0.1', '198.51.100.8', trusted);
  assert.equal(a, '198.51.100.7');
  assert.equal(b, '198.51.100.8');
  assert.notEqual(a, b); // one abusive client cannot rate-limit the other
});

test('a spoofed XFF from an UNTRUSTED peer is ignored (no bucket spoofing)', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  // Peer 203.0.113.5 is not a trusted proxy; its X-Forwarded-For is a forgery.
  assert.equal(
    deriveClientIp('203.0.113.5', '10.0.0.1, 8.8.8.8', trusted),
    '203.0.113.5',
  );
});

test('CIDR ranges match, and a proxy chain skips trusted hops to the real client', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8, 172.16.0.0/12');
  // XFF: client, then two internal proxy hops the LB appended. Rightmost
  // untrusted entry is the real client.
  const ip = deriveClientIp('10.1.2.3', '198.51.100.23, 172.16.5.5, 10.9.9.9', trusted);
  assert.equal(ip, '198.51.100.23');
});

test('all-trusted XFF falls back to the proxy peer', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  assert.equal(deriveClientIp('10.0.0.1', '10.0.0.2, 10.0.0.3', trusted), '10.0.0.1');
});

test('IPv4-mapped IPv6 peer normalizes and matches its IPv4 CIDR', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  assert.equal(deriveClientIp('::ffff:10.0.0.1', '198.51.100.1', trusted), '198.51.100.1');
});

test('IPv6 trusted proxy and client are handled', () => {
  const trusted = parseTrustedProxies('2001:db8::/32');
  const ip = deriveClientIp('2001:db8::1', '2001:4860:4860::8888', trusted);
  assert.equal(ip, '2001:4860:4860::8888');
});

test('missing remoteAddress degrades to a stable placeholder, never throws', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8');
  assert.equal(deriveClientIp(undefined, '1.2.3.4', trusted), 'unknown');
});

test('malformed trusted-proxy entries are skipped, not fatal', () => {
  const trusted = parseTrustedProxies('not-an-ip, 10.0.0.0/8, 999.999.0.0/16');
  assert.equal(trusted.contains('10.1.1.1'), true);
  assert.equal(trusted.contains('203.0.113.1'), false);
});
