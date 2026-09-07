import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOrigin, isTailscaleOrigin } from '../src/url.js';

test('a Tailscale CGNAT address is recognised', () => {
  assert.equal(isTailscaleOrigin(hostOrigin('100.82.170.69')), true);
  assert.equal(isTailscaleOrigin('http://100.64.0.1:8787'), true);
  assert.equal(isTailscaleOrigin('http://100.127.255.254:8787'), true);
});

test('LAN, public and hostname addresses are not', () => {
  assert.equal(isTailscaleOrigin(hostOrigin('192.168.1.20')), false);
  assert.equal(isTailscaleOrigin(hostOrigin('100.128.0.1')), false);
  assert.equal(isTailscaleOrigin(hostOrigin('100.63.255.255')), false);
  assert.equal(isTailscaleOrigin(hostOrigin('mac.local:8787')), false);
});

test('garbage never throws', () => {
  assert.equal(isTailscaleOrigin(null), false);
  assert.equal(isTailscaleOrigin('not a url'), false);
});
