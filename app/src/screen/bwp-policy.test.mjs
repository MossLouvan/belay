import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BWP_FIRST_FRAME_TIMEOUT_MS,
  BWP_RETRY_AFTER_MS,
  bwpDecoded,
  bwpHostSent,
  bwpOffered,
  bwpStalled,
  fallbackReasonText,
  readBwpCapability,
  shouldRequestBwp,
} from './bwp-policy.ts';

const ready = {
  preference: 'auto',
  gaming: false,
  nativeAvailable: true,
  reservedPort: 41234,
  hostBwp: true,
  lastFailureAt: null,
  now: 100_000,
};

test('a host that advertises BWP gets asked for it by default', () => {
  assert.deepEqual(shouldRequestBwp(ready), { request: true });
});

// A host older than the capability flag never says either way. Asking is
// harmless — it ignores an unknown message and keeps sending JPEG — so the
// absence of a flag must not be read as a refusal.
test('a host that does not report the flag is still asked', () => {
  assert.deepEqual(shouldRequestBwp({ ...ready, hostBwp: undefined }), { request: true });
});

test('a host that says it cannot stream this way is not asked', () => {
  assert.deepEqual(
    shouldRequestBwp({ ...ready, hostBwp: false }),
    { request: false, reason: 'host-unsupported' },
  );
});

test('a build without the native module, or without a port, cannot ask', () => {
  assert.deepEqual(
    shouldRequestBwp({ ...ready, nativeAvailable: false }),
    { request: false, reason: 'no-native' },
  );
  assert.deepEqual(shouldRequestBwp({ ...ready, reservedPort: 0 }), { request: false, reason: 'no-port' });
});

test('the manual switch wins over everything the host says', () => {
  assert.deepEqual(shouldRequestBwp({ ...ready, preference: 'off' }), { request: false, reason: 'off' });
  // Gaming prefers BWP, but an explicit "off" is the user's call to make.
  assert.deepEqual(
    shouldRequestBwp({ ...ready, preference: 'off', gaming: true }),
    { request: false, reason: 'off' },
  );
  // "on" asks even a host that said no, and even inside a cooldown: the user
  // is telling us to try, and the host's refusal will arrive as a message.
  assert.deepEqual(
    shouldRequestBwp({ ...ready, preference: 'on', hostBwp: false, lastFailureAt: ready.now - 1000 }),
    { request: true },
  );
});

test('after a failure, auto mode waits before trying again', () => {
  const failedJustNow = { ...ready, lastFailureAt: ready.now - 1000 };
  assert.deepEqual(shouldRequestBwp(failedJustNow), { request: false, reason: 'cooling-down' });
  const failedLongAgo = { ...ready, lastFailureAt: ready.now - BWP_RETRY_AFTER_MS };
  assert.deepEqual(shouldRequestBwp(failedLongAgo), { request: true });
});

// A JPEG stream cannot carry a game: 12fps at a compressed resolution. Gaming
// retries through the cooldown because the alternative is unplayable anyway.
test('gaming mode retries BWP through a cooldown', () => {
  assert.deepEqual(
    shouldRequestBwp({ ...ready, gaming: true, lastFailureAt: ready.now - 1000 }),
    { request: true },
  );
  // But not against a host that has said it cannot.
  assert.deepEqual(
    shouldRequestBwp({ ...ready, gaming: true, hostBwp: false }),
    { request: false, reason: 'host-unsupported' },
  );
});

test('an offer with no decoded frame within the timeout is a stall', () => {
  const health = bwpOffered(1000);
  assert.equal(bwpStalled(health, 1000 + BWP_FIRST_FRAME_TIMEOUT_MS - 1), false);
  assert.equal(bwpStalled(health, 1000 + BWP_FIRST_FRAME_TIMEOUT_MS), true);
});

test('a decoded frame re-arms the stall clock', () => {
  const health = bwpDecoded(bwpOffered(1000), 3900);
  assert.equal(bwpStalled(health, 3900 + BWP_FIRST_FRAME_TIMEOUT_MS - 1), false);
});

// An idle desktop sends nothing at all — the streamer skips unchanged frames
// by design — so silence after the first picture is not evidence of a fault.
// Only the host claiming to send while nothing arrives is.
test('silence after the first frame is a stall only when the host says it is sending', () => {
  const quiet = bwpDecoded(bwpOffered(1000), 2000);
  assert.equal(bwpStalled(quiet, 60_000), false);
  const hostSending = bwpHostSent(quiet, 3000);
  assert.equal(bwpStalled(hostSending, 3000 + BWP_FIRST_FRAME_TIMEOUT_MS - 1), false);
  assert.equal(bwpStalled(hostSending, 3000 + BWP_FIRST_FRAME_TIMEOUT_MS), true);
  // Repeated host reports do not push the deadline out.
  assert.equal(bwpStalled(bwpHostSent(hostSending, 4000), 6000), true);
  // Frames landing again after the host's report clears it.
  assert.equal(bwpStalled(bwpDecoded(hostSending, 6500), 9000), false);
});

test('health values are never mutated', () => {
  const first = bwpOffered(1000);
  const second = bwpDecoded(first, 2000);
  const third = bwpHostSent(second, 2500);
  assert.equal(first.lastDecodedAt, null);
  assert.equal(second.hostSendingSince, null);
  assert.equal(third.hostSendingSince, 2500);
  assert.equal(third.lastDecodedAt, 2000);
  assert.ok(Object.isFrozen(first));
});

test('the host capability flag is read strictly', () => {
  assert.equal(readBwpCapability({ bwp: true }), true);
  assert.equal(readBwpCapability({ bwp: false }), false);
  assert.equal(readBwpCapability({ bwp: 'yes' }), undefined);
  assert.equal(readBwpCapability({}), undefined);
  assert.equal(readBwpCapability(null), undefined);
});

test('every fallback reason has words a person can read', () => {
  for (const reason of ['off', 'no-native', 'no-port', 'host-unsupported', 'cooling-down']) {
    assert.ok(fallbackReasonText(reason).length > 0, reason);
  }
  assert.ok(fallbackReasonText('timeout').length > 0);
  assert.ok(fallbackReasonText('refused').length > 0);
  assert.ok(fallbackReasonText('ended').length > 0);
  assert.ok(fallbackReasonText('decoder').length > 0);
});
