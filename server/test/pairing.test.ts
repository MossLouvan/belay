// Unit tests for pairing code lifecycle: expiry, single use, burning, and the
// production refusal of the fixed test code.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateCode, currentCode, consumeCode, ensureCode, burnCode,
  testCode, testCodeActive,
} from '../src/pairing.js';

const savedTestCode = process.env.BELAY_TEST_CODE;
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.BELAY_TEST_CODE;
  delete process.env.NODE_ENV;
  burnCode();
});

afterEach(() => {
  if (savedTestCode === undefined) delete process.env.BELAY_TEST_CODE;
  else process.env.BELAY_TEST_CODE = savedTestCode;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
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

test('BELAY_TEST_CODE is honoured outside production', () => {
  process.env.BELAY_TEST_CODE = '123456';
  assert.equal(testCode(), '123456');
  assert.equal(testCodeActive(), true);

  generateCode();
  assert.equal(consumeCode('123456'), true);
  assert.equal(consumeCode('123456'), true, 'the test code is deliberately reusable');
});

test('the legacy TETHER_TEST_CODE still works outside production', () => {
  // The Playwright suite and any dev scripts written before the rename set
  // the old name; both spellings must fix the code or CI breaks on update.
  delete process.env.BELAY_TEST_CODE;
  process.env.TETHER_TEST_CODE = '654321';
  try {
    assert.equal(testCode(), '654321');
  } finally {
    delete process.env.TETHER_TEST_CODE;
  }
});

test('BELAY_TEST_CODE is REFUSED in production', () => {
  // The whole point: an env var inherited from CI or a stray .env must not be
  // able to silently disable pairing security on a real machine.
  process.env.BELAY_TEST_CODE = '123456';
  process.env.NODE_ENV = 'production';

  assert.equal(testCode(), null);
  assert.equal(testCodeActive(), false);

  const real = generateCode();
  assert.notEqual(real, '123456', 'a random code is minted instead of the forced one');
  assert.equal(consumeCode('123456'), false, 'the forced code must not pair in production');
});

test('a malformed BELAY_TEST_CODE is ignored', () => {
  for (const bad of ['abc', '12345', '1234567', '']) {
    process.env.BELAY_TEST_CODE = bad;
    assert.equal(testCode(), null, `${bad} must not be accepted as a test code`);
  }
});
