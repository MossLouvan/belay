// Unit tests for the primed-buffer ledger in ./primed.ts.
//
// Same arrangement as ./complete.test.mjs: plain ESM importing the .ts module
// directly, run by `node --test`. The scenarios at the bottom matter most:
// they walk the exact sequences — a TYPE followed by a tab — where the old
// empty-buffer assumption would have corrupted the line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTab, trackPrimed } from './primed.ts';

// --- trackPrimed -------------------------------------------------------------

test('typed text primes the buffer', () => {
  assert.equal(trackPrimed(false, 'git sta'), true);
});

test('return clears — a submitted line leaves the buffer empty', () => {
  assert.equal(trackPrimed(true, '\r'), false);
  assert.equal(trackPrimed(false, 'ls -la\r'), false);
});

test('newline, Ctrl-C and Ctrl-U all clear the line', () => {
  assert.equal(trackPrimed(true, '\n'), false);
  assert.equal(trackPrimed(true, '\x03'), false);
  assert.equal(trackPrimed(true, '\x15'), false);
});

test('text after a clearing byte re-primes', () => {
  assert.equal(trackPrimed(false, 'make\rgit'), true);
});

test('backspace and delete-char never change the flag either way', () => {
  // They can only remove — but cannot be proven to have emptied the line.
  assert.equal(trackPrimed(false, '\x7f\x08\x04'), false);
  assert.equal(trackPrimed(true, '\x7f'), true);
});

test('Ctrl-L and the bell are repaints, not insertions', () => {
  assert.equal(trackPrimed(false, '\x0c\x07'), false);
});

test('left/right arrows only move the cursor, modified word jumps included', () => {
  assert.equal(trackPrimed(false, '\x1b[D\x1b[C'), false);
  assert.equal(trackPrimed(false, '\x1b[1;5D'), false);
  assert.equal(trackPrimed(true, '\x1b[D'), true);
});

test('up/down arrows prime — history recall fills the buffer unseen', () => {
  assert.equal(trackPrimed(false, '\x1b[A'), true);
  assert.equal(trackPrimed(false, '\x1b[B'), true);
});

test('a lone Esc and unknown sequences prime, per the conservative bias', () => {
  assert.equal(trackPrimed(false, '\x1b'), true);
  assert.equal(trackPrimed(false, '\x1b[H'), true);
});

test('a CSI truncated at the end of the chunk primes rather than guesses', () => {
  assert.equal(trackPrimed(false, '\x1b[1;5'), true);
});

test('the launch keys send a whole line plus return, ending cleared', () => {
  assert.equal(trackPrimed(false, 'claude\r'), false);
});

test('a raw tab primes — the shell may have inserted or completed something', () => {
  assert.equal(trackPrimed(false, '\t'), true);
});

// --- planTab -----------------------------------------------------------------

test('empty field: the tab passes through raw, primed or not', () => {
  assert.deepEqual(planTab('', false), { kind: 'passthrough', data: '\t' });
  assert.deepEqual(planTab('', true), { kind: 'passthrough', data: '\t' });
});

test('text in the field, buffer empty: the dance applies', () => {
  assert.deepEqual(planTab('ls Doc', false), { kind: 'dance' });
});

test('text in the field, buffer primed: flush and tab natively, never dance', () => {
  assert.deepEqual(planTab('sta', true), { kind: 'flush', data: 'sta\t' });
});

// --- the invariant, end to end ----------------------------------------------
// TYPE puts "git " at the prompt; the field then holds "sta". The old code
// would have danced with "sta", the host would have replayed it onto "git "
// and Ctrl-U'd the lot away — the exact corruption this ledger exists to ban.

test('scenario: TYPE then tab flushes natively instead of dancing', () => {
  let primed = trackPrimed(false, 'git ');
  assert.equal(primed, true);

  const plan = planTab('sta', primed);
  assert.equal(plan.kind, 'flush');
  assert.equal(plan.data, 'sta\t');

  // The flush itself keeps the buffer primed: the line is still unsubmitted.
  primed = trackPrimed(primed, plan.data);
  assert.equal(primed, true);

  // Running the line restores the empty buffer, and with it the dance.
  primed = trackPrimed(primed, '\r');
  assert.equal(primed, false);
  assert.deepEqual(planTab('git sta', primed), { kind: 'dance' });
});

test('scenario: Ctrl-C after a TYPE hands the dance back too', () => {
  let primed = trackPrimed(false, 'echo half');
  primed = trackPrimed(primed, '\x03');
  assert.equal(primed, false);
  assert.equal(planTab('ls', primed).kind, 'dance');
});
