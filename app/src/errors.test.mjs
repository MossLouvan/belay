// Unit tests for the shared error-to-sentence helper.
//
//   cd app && node --test src/errors.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GENERIC_FAILURE, failureLine, humanMessage } from './errors.ts';

test('an Error speaks its own message', () => {
  assert.equal(humanMessage(new Error('the host refused')), 'the host refused');
});

test('a plain string speaks for itself', () => {
  assert.equal(humanMessage('disk full'), 'disk full');
});

test('a native-module object with a message is read, not stringified', () => {
  assert.equal(humanMessage({ message: 'camera busy' }), 'camera busy');
});

test('nothing readable ever reaches the user as [object Object]', () => {
  for (const thrown of [{}, { code: 7 }, [], null, undefined, 42, true, Symbol('x')]) {
    const out = humanMessage(thrown, 'could not save');
    assert.equal(out, 'could not save', String(thrown?.toString?.() ?? thrown));
    assert.doesNotMatch(out, /\[object/);
  }
});

test('blank and whitespace-only messages fall through to the fallback', () => {
  assert.equal(humanMessage(new Error(''), 'no reason given'), 'no reason given');
  assert.equal(humanMessage(new Error('   '), 'no reason given'), 'no reason given');
  assert.equal(humanMessage('   ', 'no reason given'), 'no reason given');
});

test('messages are trimmed so a banner never opens on whitespace', () => {
  assert.equal(humanMessage(new Error('  timed out \n')), 'timed out');
});

test('the result is never empty, even with an empty fallback', () => {
  assert.equal(humanMessage({}, ''), GENERIC_FAILURE);
  assert.equal(humanMessage(null, '   '), GENERIC_FAILURE);
});

test('humanMessage never throws, whatever it is handed', () => {
  const hostile = { get message() { throw new Error('boom'); } };
  assert.doesNotThrow(() => humanMessage(hostile, 'fallback'));
});

test('failureLine adds the dash only when there is a reason', () => {
  assert.equal(failureLine('Recording failed', new Error('no disk')), 'Recording failed — no disk');
});

test('failureLine never leaves a dangling em dash', () => {
  for (const thrown of [{}, null, undefined, '', '  ']) {
    assert.equal(failureLine('Recording failed', thrown), 'Recording failed');
  }
});
