// Unit tests for the handoff outcome parsing and its copy.
//
//   cd app && node --test src/handoff/handoff.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { busyExplanation, openedNote, parseHandoff } from './handoff-model.ts';

const CMD = `cd '/Users/me/My Projects/app' && claude --resume abc`;

test('an opened answer names the terminal and keeps the command', () => {
  const out = parseHandoff(200, { ok: true, opened: true, terminal: 'iTerm', stopped: false, command: CMD });
  assert.deepEqual(out, { kind: 'opened', terminal: 'iTerm', stopped: false, command: CMD });
});

test('opened without a terminal name still reads as a terminal', () => {
  const out = parseHandoff(200, { ok: true, opened: true, command: CMD });
  assert.equal(out.kind, 'opened');
  assert.equal(out.terminal, 'a terminal');
});

test('opened:false is the copy-it-yourself fallback, with the host reason', () => {
  const out = parseHandoff(200, { ok: true, opened: false, command: CMD, reason: 'no terminal app on this computer' });
  assert.deepEqual(out, { kind: 'fallback', command: CMD, reason: 'no terminal app on this computer' });
});

test('409 busy carries the status and the command, and touches nothing', () => {
  const out = parseHandoff(409, { busy: true, status: 'waiting', command: CMD });
  assert.deepEqual(out, { kind: 'busy', status: 'waiting', command: CMD });
});

test('a host error surfaces its own wording', () => {
  assert.throws(() => parseHandoff(404, { error: 'no such session' }), /no such session/);
});

test('a drifted or empty answer throws instead of half-rendering', () => {
  assert.throws(() => parseHandoff(200, {}), /answered strangely \(200\)/);
  assert.throws(() => parseHandoff(200, null), /answered strangely/);
  // opened:true but no command — the screen could not offer the fallback.
  assert.throws(() => parseHandoff(200, { opened: true }), /answered strangely/);
});

test('the busy copy names the consequence before it happens', () => {
  assert.match(busyExplanation('running'), /stop it here, mid-task/);
  assert.match(busyExplanation('waiting'), /deny that ask/);
  // Both spell out why two clients are never allowed.
  assert.match(busyExplanation('running'), /lets go first/);
});

test('the opened note says who owns the conversation now', () => {
  assert.match(openedNote('iTerm', true), /stopped its side first/);
  assert.match(openedNote('Terminal', false), /let go of its side/);
  assert.match(openedNote('Terminal', false), /Terminal window on the computer now owns/);
});
