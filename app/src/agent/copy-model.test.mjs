// Unit tests for the Copy affordance's pure logic: the words on the label
// through its ✓/✗ flash, and which transcript messages earn their own Copy
// control instead of leaning on text selection alone.
//
//   cd app && node --test src/agent/copy-model.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, and
// only JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COPY_FLASH_MS, MESSAGE_COPY_MIN_CHARS, copyLabel, showMessageCopy } from './copy-model.ts';

// ---- label ------------------------------------------------------------------

test('the label rests on the verb and flashes the outcome', () => {
  assert.equal(copyLabel('idle'), 'Copy');
  assert.equal(copyLabel('copied'), '✓ Copied');
  assert.equal(copyLabel('failed'), '✗ Failed');
});

test('the flash duration is a positive number of milliseconds', () => {
  assert.ok(Number.isFinite(COPY_FLASH_MS) && COPY_FLASH_MS > 0);
});

// ---- which messages get a Copy control --------------------------------------

test('a user prompt with text always earns Copy', () => {
  assert.equal(showMessageCopy({ t: 1, kind: 'user', text: 'fix the tests' }), true);
});

test('an empty or whitespace user prompt does not', () => {
  assert.equal(showMessageCopy({ t: 1, kind: 'user', text: '' }), false);
  assert.equal(showMessageCopy({ t: 1, kind: 'user', text: '   ' }), false);
  assert.equal(showMessageCopy({ t: 1, kind: 'user' }), false);
});

test('short one-line narration leans on selection, not a control', () => {
  assert.equal(showMessageCopy({ t: 1, kind: 'text', text: 'Running tests.' }), false);
});

test('multi-line narration earns Copy regardless of length', () => {
  assert.equal(showMessageCopy({ t: 1, kind: 'text', text: 'a\nb' }), true);
});

test('long one-line narration earns Copy at the threshold', () => {
  const long = 'x'.repeat(MESSAGE_COPY_MIN_CHARS);
  assert.equal(showMessageCopy({ t: 1, kind: 'text', text: long }), true);
  assert.equal(showMessageCopy({ t: 1, kind: 'text', text: long.slice(1) }), false);
});

test('non-message kinds never show the message Copy control', () => {
  for (const kind of ['tool', 'tool-result', 'result', 'info', 'error']) {
    assert.equal(showMessageCopy({ t: 1, kind, text: 'plenty of text\nwith lines' }), false);
  }
});
