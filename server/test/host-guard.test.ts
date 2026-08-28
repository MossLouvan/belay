// DNS-rebinding defence: only hostnames the app could legitimately have typed
// or discovered are accepted in the Host header (and browser Origin).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTrustedHost, isTrustedOrigin } from '../src/host-guard.js';

test('IP literals, localhost and .local names are trusted, with or without a port', () => {
  for (const h of ['192.168.1.20:8787', '100.101.102.103', 'localhost:8787', '127.0.0.1', '[::1]:8787',
    '[fd7a:115c:a1e0::1]:8787', 'desktop-abc.local:8787', 'LOCALHOST']) {
    assert.equal(isTrustedHost(h), true, h);
  }
});

test('any other hostname is refused — that is what a rebinding attack looks like', () => {
  for (const h of ['evil.example:8787', 'evil.example', 'tether.evil.example', '', undefined,
    '192.168.1.20.evil.example', 'localhost.evil.example']) {
    assert.equal(isTrustedHost(h), false, String(h));
  }
});

test('TETHER_HOSTS adds names, case-insensitively', () => {
  const prev = process.env.TETHER_HOSTS;
  process.env.TETHER_HOSTS = 'MyPC.tail1234.ts.net, other.example';
  try {
    assert.equal(isTrustedHost('mypc.tail1234.ts.net:8787'), true);
    assert.equal(isTrustedHost('other.example'), true);
    assert.equal(isTrustedHost('third.example'), false);
  } finally {
    if (prev === undefined) delete process.env.TETHER_HOSTS; else process.env.TETHER_HOSTS = prev;
  }
});

test('origins: absent (native app) is fine, trusted hosts pass, anything else fails', () => {
  assert.equal(isTrustedOrigin(undefined), true);
  assert.equal(isTrustedOrigin('http://localhost:8081'), true);
  assert.equal(isTrustedOrigin('http://192.168.1.20:8081'), true);
  assert.equal(isTrustedOrigin('http://evil.example'), false);
  assert.equal(isTrustedOrigin('not a url'), false);
});
