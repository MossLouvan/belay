// Unit tests for the agent model's pure helpers.
//
//   cd app && node --test src/agent/model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UNTITLED_SESSION, sessionPreviewLabel } from './model.ts';

test('sessionPreviewLabel strips the XML-ish wrappers Claude Code adds', () => {
  assert.equal(
    sessionPreviewLabel('<local-command-caveat>Caveat: the message below was generated</local-command-caveat>'),
    'Caveat: the message below was generated'
  );
  assert.equal(sessionPreviewLabel('<command-name>/rc</command-name>'), '/rc');
});

test('sessionPreviewLabel collapses newlines so a row cannot grow', () => {
  assert.equal(sessionPreviewLabel('first line\n\n  second line\t third'), 'first line second line third');
});

test('sessionPreviewLabel leaves ordinary prompts exactly as typed', () => {
  assert.equal(sessionPreviewLabel('Fix the login bug'), 'Fix the login bug');
  assert.equal(sessionPreviewLabel('a < b and c > d'), 'a < b and c > d');
});

test('sessionPreviewLabel never returns an empty row title', () => {
  for (const input of ['', '   ', '<tag></tag>', null, undefined, 42]) {
    assert.equal(sessionPreviewLabel(input), UNTITLED_SESSION, JSON.stringify(input));
  }
});
