// The clipboard sheet's pure logic: previews, size pre-checks, and the notice
// for every outcome. These strings are the whole feedback surface of a feature
// that moves the user's text between machines, so each one is pinned.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLIPBOARD_UNITS,
  checkPush,
  failureNotice,
  previewOf,
  pulledNotice,
  pushedNotice,
} from './clipboard-model.ts';

// --- previews ----------------------------------------------------------------

test('a short text previews as itself, whitespace collapsed', () => {
  assert.equal(previewOf('  hello\n\t world  '), 'hello world');
});

test('a long text is cut with an ellipsis', () => {
  const preview = previewOf('a'.repeat(500));
  assert.equal(preview.length, 141);
  assert.ok(preview.endsWith('…'));
});

test('the preview cut never splits a surrogate pair', () => {
  const preview = previewOf('😀'.repeat(300), 10);
  assert.equal([...preview].length, 11); // 10 whole emoji + the ellipsis
  assert.ok(preview.endsWith('…'));
  assert.ok(!preview.includes('�'));
});

// --- pull notices ------------------------------------------------------------

test('an empty pull says so quietly, not as an error', () => {
  assert.deepEqual(pulledNotice('', false, false), {
    tone: 'dim',
    text: 'The computer’s clipboard has no text',
  });
});

test('a successful pull reports the copy onto the phone', () => {
  const notice = pulledNotice('hello', false, true);
  assert.equal(notice.tone, 'ok');
  assert.match(notice.text, /Copied 5 characters/);
});

test('a truncated pull says the computer had more', () => {
  const notice = pulledNotice('hello', true, true);
  assert.equal(notice.tone, 'ok');
  assert.match(notice.text, /cut at the cap/);
});

test('text that arrived but could not be copied is a failure, not a success', () => {
  const notice = pulledNotice('hello', false, false);
  assert.equal(notice.tone, 'bad');
  assert.match(notice.text, /refused/);
});

// --- push pre-checks ---------------------------------------------------------

test('an empty phone clipboard refuses the push quietly', () => {
  for (const value of [null, '']) {
    const check = checkPush(value);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.notice.tone, 'dim');
  }
});

test('text at the cap is sendable; one unit over is refused with the limit named', () => {
  assert.equal(checkPush('x'.repeat(MAX_CLIPBOARD_UNITS)).ok, true);
  const over = checkPush('x'.repeat(MAX_CLIPBOARD_UNITS + 1));
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.notice.tone, 'bad');
    assert.match(over.notice.text, /100,000|100000/);
  }
});

test('a sendable check hands back the exact text', () => {
  const check = checkPush('exactly this');
  assert.deepEqual(check, { ok: true, text: 'exactly this' });
});

// --- outcome notices ---------------------------------------------------------

test('a push success counts what was sent', () => {
  const notice = pushedNotice(1234);
  assert.equal(notice.tone, 'ok');
  assert.match(notice.text, /1,234 characters/);
});

test('failures speak the error message, and garbage still says something', () => {
  assert.deepEqual(failureNotice(new Error('the computer did not answer in time')), {
    tone: 'bad',
    text: 'the computer did not answer in time',
  });
  for (const garbage of [undefined, null, 'boom', 42, new Error('')]) {
    assert.deepEqual(failureNotice(garbage), { tone: 'bad', text: 'something went wrong' });
  }
});
