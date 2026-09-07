import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXAMPLE_TAILSCALE_ADDRESS, addressFeedback } from '../src/address-feedback.js';

test('an empty field has nothing to say yet', () => {
  assert.equal(addressFeedback(''), null);
  assert.equal(addressFeedback('   '), null);
  assert.equal(addressFeedback(undefined), null);
});

test('a Tailscale address is reassured, with or without a port or scheme', () => {
  for (const input of ['100.101.102.103', '100.64.0.1:8787', 'http://100.127.255.254', ' 100.101.102.103 ']) {
    const line = addressFeedback(input);
    assert.equal(line.tone, 'good', input);
    assert.match(line.text, /Tailscale address/);
  }
});

test('a MagicDNS name is a Tailscale name', () => {
  assert.deepEqual(addressFeedback('mac.tail1234.ts.net'), { tone: 'good', text: 'Looks like a Tailscale name' });
});

test('digits heading towards 100. are encouraged, others are nudged', () => {
  assert.equal(addressFeedback('1').tone, 'dim');
  assert.equal(addressFeedback('100.101').tone, 'dim');
  assert.match(addressFeedback('100.101').text, new RegExp(EXAMPLE_TAILSCALE_ADDRESS));
  assert.deepEqual(addressFeedback('192.168'), { tone: 'warn', text: 'Tailscale addresses start with 100.' });
});

test('a LAN address works but only on the same network', () => {
  const line = addressFeedback('192.168.1.20:8787');
  assert.equal(line.tone, 'warn');
  assert.match(line.text, /same network/);
});

test('a plain computer name is allowed, quietly', () => {
  assert.equal(addressFeedback('mac.local').tone, 'dim');
});

test('spaces and unparseable text are rejected in words', () => {
  assert.equal(addressFeedback('mac local').tone, 'bad');
  assert.equal(addressFeedback('999.1.1.1').tone, 'bad');
  assert.match(addressFeedback('999.1.1.1').text, /not an address/);
});

test('the result is frozen', () => {
  assert.ok(Object.isFrozen(addressFeedback('100.101.102.103')));
});
