// DNS-rebinding defence: only hostnames the app could legitimately have typed
// or discovered are accepted in the Host header (and browser Origin).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTrustedHost, isTrustedOrigin, pairRefusal } from '../src/host-guard.js';

test('IP literals, localhost and .local names are trusted, with or without a port', () => {
  for (const h of ['192.168.1.20:8787', '100.101.102.103', 'localhost:8787', '127.0.0.1', '[::1]:8787',
    '[fd7a:115c:a1e0::1]:8787', 'desktop-abc.local:8787', 'LOCALHOST']) {
    assert.equal(isTrustedHost(h), true, h);
  }
});

test('any other hostname is refused — that is what a rebinding attack looks like', () => {
  for (const h of ['evil.example:8787', 'evil.example', 'belay.evil.example', '', undefined,
    '192.168.1.20.evil.example', 'localhost.evil.example']) {
    assert.equal(isTrustedHost(h), false, String(h));
  }
});

test('BELAY_HOSTS adds names, case-insensitively', () => {
  const prev = process.env.BELAY_HOSTS;
  process.env.BELAY_HOSTS = 'MyPC.tail1234.ts.net, other.example';
  try {
    assert.equal(isTrustedHost('mypc.tail1234.ts.net:8787'), true);
    assert.equal(isTrustedHost('other.example'), true);
    assert.equal(isTrustedHost('third.example'), false);
  } finally {
    if (prev === undefined) delete process.env.BELAY_HOSTS; else process.env.BELAY_HOSTS = prev;
  }
});

test('origins: absent (native app) is fine, trusted hosts pass, anything else fails', () => {
  assert.equal(isTrustedOrigin(undefined), true);
  assert.equal(isTrustedOrigin('http://localhost:8081'), true);
  assert.equal(isTrustedOrigin('http://192.168.1.20:8081'), true);
  assert.equal(isTrustedOrigin('http://evil.example'), false);
  assert.equal(isTrustedOrigin('not a url'), false);
});

test('opaque origins are treated as non-browser clients', () => {
  // The Electron desktop client loads its renderer from file://, so its
  // WebSocket upgrade carries `Origin: file://`; a sandboxed document sends
  // the literal `null`. Neither parses to a host, and refusing them is what
  // kept the desktop client from connecting at all. The Host-header check is
  // what actually stops DNS rebinding, and it still applies to both.
  assert.equal(isTrustedOrigin('file://'), true);
  assert.equal(isTrustedOrigin('null'), true);
  assert.equal(isTrustedOrigin('NULL'), true);
  assert.equal(isTrustedOrigin(undefined), true);
});

test('a real web origin is still checked against the host allow-list', () => {
  assert.equal(isTrustedOrigin('http://evil.example'), false);
  assert.equal(isTrustedOrigin('http://192.168.1.35:8787'), true);
  assert.equal(isTrustedOrigin('not a url'), false);
});

const ALLOWED = ['http://localhost:8081', 'http://127.0.0.1:8081'];

test('/pair from the real clients is allowed through', () => {
  // The iOS app: no Origin, JSON body.
  assert.equal(pairRefusal({ 'content-type': 'application/json' }, ALLOWED), null);
  // The Electron desktop client: opaque origin from file://, JSON body.
  assert.equal(pairRefusal({ origin: 'file://', 'content-type': 'application/json' }, ALLOWED), null);
  assert.equal(pairRefusal({ origin: 'null', 'content-type': 'application/json; charset=utf-8' }, ALLOWED), null);
  // The local web build, which is on the CORS list.
  assert.equal(pairRefusal({ origin: 'http://localhost:8081', 'content-type': 'application/json' }, ALLOWED), null);
});

test('/pair from any other web origin is refused with 403 before it can count as a failure', () => {
  assert.deepEqual(
    pairRefusal({ origin: 'https://evil.example', 'content-type': 'application/json' }, ALLOWED),
    { status: 403, error: 'origin not allowed' },
  );
  // An IP-literal origin passes the Host check but is still not the web build.
  assert.equal(pairRefusal({ origin: 'http://192.168.0.35:8787', 'content-type': 'application/json' }, ALLOWED)?.status, 403);
});

test('/pair with a non-JSON body is refused with 400', () => {
  // The cross-site text/plain POST that needs no CORS preflight.
  assert.deepEqual(
    pairRefusal({ origin: 'https://evil.example', 'content-type': 'text/plain' }, ALLOWED)?.status, 403,
  );
  assert.equal(pairRefusal({ 'content-type': 'text/plain' }, ALLOWED)?.status, 400);
  assert.equal(pairRefusal({ 'content-type': 'application/x-www-form-urlencoded' }, ALLOWED)?.status, 400);
  assert.equal(pairRefusal({}, ALLOWED)?.status, 400);
});
