// Unit tests for the clipboard sync validation and shaping (src/clipboard.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLIPBOARD_UNITS,
  parseClipboardSet,
  shapeClipboardGet,
  truncatedAtSafePoint,
} from '../src/clipboard.js';

// ---- POST body validation ---------------------------------------------------

test('a plain text push is accepted verbatim', () => {
  const parsed = parseClipboardSet({ text: 'hello from the phone' });
  assert.deepEqual(parsed, { ok: true, text: 'hello from the phone' });
});

test('an empty string is a valid push (it clears the host clipboard)', () => {
  assert.deepEqual(parseClipboardSet({ text: '' }), { ok: true, text: '' });
});

test('text at exactly the cap is accepted', () => {
  const parsed = parseClipboardSet({ text: 'x'.repeat(MAX_CLIPBOARD_UNITS) });
  assert.equal(parsed.ok, true);
});

test('text over the cap is refused with 413 and names the limit', () => {
  const parsed = parseClipboardSet({ text: 'x'.repeat(MAX_CLIPBOARD_UNITS + 1) });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.status, 413);
    assert.match(parsed.error, new RegExp(String(MAX_CLIPBOARD_UNITS)));
  }
});

test('a body that is not an object is refused with 400', () => {
  for (const body of [undefined, null, 'text', 42, true]) {
    const parsed = parseClipboardSet(body);
    assert.equal(parsed.ok, false, `expected refusal for ${JSON.stringify(body)}`);
    if (!parsed.ok) assert.equal(parsed.status, 400);
  }
});

test('a non-string text field is refused, never coerced', () => {
  for (const text of [undefined, null, 42, true, ['a'], { s: 'a' }]) {
    const parsed = parseClipboardSet({ text });
    assert.equal(parsed.ok, false, `expected refusal for text=${JSON.stringify(text)}`);
    if (!parsed.ok) assert.equal(parsed.status, 400);
  }
});

test('validation does not mutate the body it was handed', () => {
  const body = { text: 'unchanged' };
  parseClipboardSet(body);
  assert.deepEqual(body, { text: 'unchanged' });
});

// ---- helper reply shaping ---------------------------------------------------

test('a well-formed helper reply passes through', () => {
  assert.deepEqual(shapeClipboardGet({ id: 3, ok: true, text: 'from the host' }), {
    text: 'from the host',
    truncated: false,
  });
});

test('the helper saying it truncated is passed on', () => {
  assert.deepEqual(shapeClipboardGet({ text: 'partial', truncated: true }), {
    text: 'partial',
    truncated: true,
  });
});

test('a reply without usable text collapses to empty, not a crash', () => {
  for (const reply of [undefined, null, 'text', 42, {}, { text: 42 }, { text: null }, { text: ['a'] }]) {
    assert.deepEqual(shapeClipboardGet(reply), { text: '', truncated: false });
  }
});

test('an over-cap helper reply is cut and marked truncated', () => {
  const shaped = shapeClipboardGet({ text: 'y'.repeat(MAX_CLIPBOARD_UNITS + 50) });
  assert.equal(shaped.text.length, MAX_CLIPBOARD_UNITS);
  assert.equal(shaped.truncated, true);
});

// ---- surrogate-safe truncation ----------------------------------------------

test('a cut never splits a surrogate pair', () => {
  // '😀' is two UTF-16 units; a limit landing between them must back off.
  const text = 'ab😀cd';
  assert.equal(truncatedAtSafePoint(text, 3), 'ab'); // cut inside the pair
  assert.equal(truncatedAtSafePoint(text, 4), 'ab😀'); // cut after the pair
});

test('truncation edge cases', () => {
  assert.equal(truncatedAtSafePoint('abc', 3), 'abc'); // at the limit: untouched
  assert.equal(truncatedAtSafePoint('abc', 10), 'abc'); // under the limit: untouched
  assert.equal(truncatedAtSafePoint('abc', 0), ''); // zero limit: empty
});

test('an over-cap reply ending mid-emoji still ends on a whole character', () => {
  const text = 'z'.repeat(MAX_CLIPBOARD_UNITS - 1) + '😀!';
  const shaped = shapeClipboardGet({ text });
  // The high surrogate sat at the cap boundary; the cut must back off one.
  assert.equal(shaped.text.length, MAX_CLIPBOARD_UNITS - 1);
  assert.equal(shaped.truncated, true);
  assert.equal(shaped.text.at(-1), 'z');
});
