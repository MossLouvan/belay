// SocketRocket (React Native's WebSocket) calls
// +[SRSecurityPolicy pinnningPolicyWithCertificates:] for any request whose
// SR_SSLPinnedCertificates is non-nil, and upstream that method only raises
// NSInvalidArgumentException. BelayPinModule.swift once fed pins through that
// getter alone, so the first WebSocket to a paired computer aborted the app.
//
//   cd app && node --test src/devices/socket-pinning.test.mjs
//
// The Swift cannot be compiled here; this pins the order that keeps it safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const swift = readFileSync(
  new URL('../../modules/belay-stream/ios/BelayPinModule.swift', import.meta.url),
  'utf8',
);

const body = name => {
  const start = swift.indexOf(`func ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = swift.indexOf('\n    private func ', start + 1);
  return swift.slice(start, next < 0 ? undefined : next);
};

test('the pinned-certificates getter is only swapped after the SocketRocket policy is', () => {
  const pins = body('installSocketRocketPins');
  const guard = pins.indexOf('guard installSocketRocketPolicy() else { return }');
  assert.ok(guard >= 0, 'bails out when the policy cannot be replaced');
  assert.ok(guard < pins.indexOf('SR_SSLPinnedCertificates'), 'before touching the getter');
});

test('the policy replaces the raising factory and evaluates the pinned list', () => {
  const policy = body('installSocketRocketPolicy');
  assert.match(policy, /"pinnningPolicyWithCertificates:"/);
  assert.match(policy, /"evaluateServerTrust:forDomain:"/);
  assert.match(policy, /initWithCertificateChainValidationEnabled:/);
  assert.match(policy, /method_setImplementation\(factory,/);
  assert.match(policy, /method_setImplementation\(evaluate,/);
});
