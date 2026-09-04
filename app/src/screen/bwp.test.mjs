// Unit tests for BWP negotiation on the remote-screen tab.
//
//   cd app && node --test src/screen/bwp.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.
//
// What these protect: the negotiation is the one part of the new video path
// that runs in JavaScript, and every failure in it presents identically to the
// user — a black screen. So the tests are mostly about refusing malformed
// offers loudly rather than passing them to the native layer, where the
// resulting failure would point somewhere else entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBwpStart,
  buildBwpStop,
  hostFromSocketUrl,
  parseBwpMessage,
} from './bwp.ts';

const KEY = 'a'.repeat(64);
const SALT = '0102030405060708';

const offerMessage = (over = {}) => ({
  type: 'bwpOffer',
  port: 42100,
  key: KEY,
  salt: SALT,
  width: 1920,
  height: 1080,
  path: 'gpu',
  ...over,
});

test('a well-formed offer is parsed', () => {
  const msg = parseBwpMessage(offerMessage());
  assert.equal(msg?.type, 'offer');
  assert.equal(msg.offer.port, 42100);
  assert.equal(msg.offer.key, KEY);
  assert.equal(msg.offer.width, 1920);
  assert.equal(msg.offer.path, 'gpu');
});

test('an offer arriving as a JSON string is parsed too', () => {
  const msg = parseBwpMessage(JSON.stringify(offerMessage()));
  assert.equal(msg?.type, 'offer');
  assert.equal(msg.offer.port, 42100);
});

// A missing key would reach the native layer as the string "undefined" and
// fail there, pointing at the session rather than at the negotiation. Refusing
// here keeps the error where the cause is.
test('an offer missing or short on key material is refused, not passed through', () => {
  assert.equal(parseBwpMessage(offerMessage({ key: undefined })), null);
  assert.equal(parseBwpMessage(offerMessage({ key: '' })), null);
  assert.equal(parseBwpMessage(offerMessage({ key: 'abcd' })), null, 'too short');
  assert.equal(parseBwpMessage(offerMessage({ salt: undefined })), null);
  assert.equal(parseBwpMessage(offerMessage({ salt: '0102' })), null, 'wrong length');
  assert.equal(parseBwpMessage(offerMessage({ salt: 'x'.repeat(20) })), null);
});

test('an offer without a usable port is refused', () => {
  assert.equal(parseBwpMessage(offerMessage({ port: undefined })), null);
  assert.equal(parseBwpMessage(offerMessage({ port: 0 })), null);
  assert.equal(parseBwpMessage(offerMessage({ port: -1 })), null);
  assert.equal(parseBwpMessage(offerMessage({ port: '42100' })), null, 'a string is not a port');
});

test('missing dimensions default rather than rejecting the offer', () => {
  // A host that cannot report its size can still stream; the view scales to
  // whatever the decoder reports from the SPS anyway.
  const msg = parseBwpMessage(offerMessage({ width: undefined, height: undefined }));
  assert.equal(msg?.type, 'offer');
  assert.equal(msg.offer.width, 0);
  assert.equal(msg.offer.height, 0);
});

test('unavailable and ended carry their reason', () => {
  assert.deepEqual(
    parseBwpMessage({ type: 'bwpUnavailable', error: 'not built for this platform' }),
    { type: 'unavailable', error: 'not built for this platform' },
  );
  assert.deepEqual(
    parseBwpMessage({ type: 'bwpEnded', error: 'stream exited (1)' }),
    { type: 'ended', error: 'stream exited (1)' },
  );
});

// A host that reports a failure with no message must still produce a message:
// an empty error banner tells the user nothing at all.
test('a reason-less failure still gets a message', () => {
  assert.equal(parseBwpMessage({ type: 'bwpUnavailable' })?.error.length > 0, true);
  assert.equal(parseBwpMessage({ type: 'bwpEnded' })?.error.length > 0, true);
});

test('stats and bitrate are parsed', () => {
  assert.deepEqual(
    parseBwpMessage({ type: 'bwpStats', fps: 59, kbps: 1521, bitrate: 2776395 }),
    { type: 'stats', stats: { fps: 59, kbps: 1521, bitrate: 2776395 } },
  );
  assert.deepEqual(parseBwpMessage({ type: 'bwpBitrate', bps: 4405791 }), {
    type: 'bitrate',
    bps: 4405791,
  });
});

test('unrelated and malformed messages are ignored', () => {
  for (const junk of [
    null,
    undefined,
    42,
    'not json',
    '{"broken',
    {},
    { type: 'frame', data: 'abc' },
    { type: 'error', error: 'something else' },
    [],
  ]) {
    assert.equal(parseBwpMessage(junk), null, `must ignore ${JSON.stringify(junk)}`);
  }
});

test('the start message carries the reserved port', () => {
  const msg = JSON.parse(buildBwpStart(41234, 'high', 60));
  assert.deepEqual(msg, { type: 'bwpStart', port: 41234, preset: 'high', fps: 60 });
  assert.deepEqual(JSON.parse(buildBwpStop()), { type: 'bwpStop' });
});

// The host address comes from the socket we already authenticated against,
// never from a message — a host field in a message would be a redirect we have
// no reason to honour.
test('the host is taken from the control socket URL', () => {
  assert.equal(hostFromSocketUrl('ws://192.168.1.10:8080/ws/screen'), '192.168.1.10');
  assert.equal(hostFromSocketUrl('wss://desktop.local:8443/ws/screen?w=1280'), 'desktop.local');
  assert.equal(hostFromSocketUrl('ws://192.168.1.10/ws/screen'), '192.168.1.10');
});

test('a bracketed IPv6 host is unwrapped', () => {
  assert.equal(hostFromSocketUrl('ws://[fe80::1]:8080/ws/screen'), 'fe80::1');
  assert.equal(hostFromSocketUrl('ws://[::1]:8080/ws/screen'), '::1');
});

test('a URL that is not a websocket yields no host', () => {
  assert.equal(hostFromSocketUrl('http://192.168.1.10:8080/'), null);
  assert.equal(hostFromSocketUrl(''), null);
  assert.equal(hostFromSocketUrl('ws://'), null);
});
