// Unit tests for pairing code lifecycle: expiry, single use, burning, and the
// production refusal of the fixed test code.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateCode, currentCode, consumeCode, ensureCode, burnCode,
  testCode, testCodeActive,
} from '../src/pairing.js';

const savedTestCode = process.env.BELAY_TEST_CODE;
const savedAllow = process.env.BELAY_ALLOW_TEST_CODE;
const savedLegacy = process.env.TETHER_TEST_CODE;
const savedNodeEnv = process.env.NODE_ENV;

const restore = (key: string, saved: string | undefined) => {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
};

beforeEach(() => {
  delete process.env.BELAY_TEST_CODE;
  delete process.env.BELAY_ALLOW_TEST_CODE;
  delete process.env.TETHER_TEST_CODE;
  delete process.env.NODE_ENV;
  burnCode();
});

afterEach(() => {
  restore('BELAY_TEST_CODE', savedTestCode);
  restore('BELAY_ALLOW_TEST_CODE', savedAllow);
  restore('TETHER_TEST_CODE', savedLegacy);
  restore('NODE_ENV', savedNodeEnv);
  burnCode();
});

test('a generated code is six digits', () => {
  const code = generateCode();
  assert.match(code, /^\d{6}$/);
});

test('the correct code pairs exactly once', () => {
  const code = generateCode();
  assert.equal(consumeCode(code), true);
  assert.equal(consumeCode(code), false, 'a burned code must not pair a second device');
});

test('a wrong code does not pair and does not burn the real one', () => {
  const code = generateCode();
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(consumeCode(wrong), false);
  assert.equal(consumeCode(code), true, 'the real code still works after a wrong guess');
});

test('consuming when no code exists is refused', () => {
  burnCode();
  assert.equal(consumeCode('123456'), false);
});

test('burnCode invalidates the live code', () => {
  const code = generateCode();
  assert.ok(currentCode());
  burnCode();
  assert.equal(currentCode(), null);
  assert.equal(consumeCode(code), false, 'a burned code must not pair');
});

test('currentCode reports remaining lifetime', () => {
  generateCode();
  const c = currentCode();
  assert.ok(c);
  assert.ok(c.expiresInSec > 0 && c.expiresInSec <= 300);
});

test('ensureCode mints one only when there is none', () => {
  burnCode();
  ensureCode();
  const first = currentCode();
  assert.ok(first);

  ensureCode();
  assert.equal(currentCode()?.code, first.code, 'an existing valid code is left alone');
});

test('code comparison rejects a wrong-length input without throwing', () => {
  // timingSafeEqual throws on mismatched buffer lengths; the wrapper must not.
  generateCode();
  assert.equal(consumeCode(''), false);
  assert.equal(consumeCode('1'), false);
  assert.equal(consumeCode('12345678901234'), false);
});

test('BELAY_TEST_CODE is honoured only with the explicit opt-in', () => {
  process.env.BELAY_TEST_CODE = '123456';
  process.env.BELAY_ALLOW_TEST_CODE = '1';
  assert.equal(testCode(), '123456');
  assert.equal(testCodeActive(), true);

  generateCode();
  assert.equal(consumeCode('123456'), true);
  assert.equal(consumeCode('123456'), true, 'the test code is deliberately reusable');
});

// Regression: the core of the reported bug. Before the fix, `testCode()` was
// refused only when NODE_ENV === 'production' — a branch nothing in the shipped
// run path ever set — so a BELAY_TEST_CODE alone silently disabled pairing on a
// real machine. The opt-in must be required, and its absence must fire the guard.
test('BELAY_TEST_CODE alone (no opt-in) is REFUSED — the shipped default', () => {
  process.env.BELAY_TEST_CODE = '123456';
  // No BELAY_ALLOW_TEST_CODE, no NODE_ENV — exactly `npm start` on a real box.
  delete process.env.BELAY_ALLOW_TEST_CODE;
  delete process.env.NODE_ENV;

  assert.equal(testCode(), null, 'the fixed code must not activate without the opt-in');
  assert.equal(testCodeActive(), false);

  const real = generateCode();
  assert.notEqual(real, '123456', 'a random code is minted instead of the forced one');
  assert.equal(consumeCode('123456'), false, 'the forced code must not pair');
});

test('an opt-in flag other than "1" does not activate the test code', () => {
  process.env.BELAY_TEST_CODE = '123456';
  for (const v of ['0', 'true', 'yes', '']) {
    process.env.BELAY_ALLOW_TEST_CODE = v;
    assert.equal(testCode(), null, `BELAY_ALLOW_TEST_CODE=${JSON.stringify(v)} must not activate`);
  }
});

test('the legacy TETHER_TEST_CODE no longer activates the test code', () => {
  // This is a test knob, not a user setting, so the compat shim is deliberately
  // dropped for it — a stray legacy variable in a shell profile must not be able
  // to weaken pairing. (Other TETHER_* settings keep their fallback via env.ts.)
  delete process.env.BELAY_TEST_CODE;
  process.env.BELAY_ALLOW_TEST_CODE = '1';
  process.env.TETHER_TEST_CODE = '654321';
  assert.equal(testCode(), null, 'the legacy name must not fix the code');
  assert.equal(testCodeActive(), false);
});

// Regression: burning the code must actually take the fixed test code out of
// service. Before the fix, `consumeCode` short-circuited on the forced code and
// never consulted burn state, so the per-code brute-force budget (which calls
// burnCode after 20 combined failures) was a complete no-op in test mode.
test('burnCode disables the fixed test code until a new one is minted', () => {
  process.env.BELAY_TEST_CODE = '123456';
  process.env.BELAY_ALLOW_TEST_CODE = '1';

  generateCode();
  assert.equal(consumeCode('123456'), true, 'active before the burn');

  burnCode();
  assert.equal(consumeCode('123456'), false, 'a burned test code must not pair');

  generateCode();
  assert.equal(consumeCode('123456'), true, 'a freshly minted code re-enables pairing');
});

test('a malformed BELAY_TEST_CODE is ignored even with the opt-in', () => {
  process.env.BELAY_ALLOW_TEST_CODE = '1';
  for (const bad of ['abc', '12345', '1234567', '']) {
    process.env.BELAY_TEST_CODE = bad;
    assert.equal(testCode(), null, `${bad} must not be accepted as a test code`);
  }
});
