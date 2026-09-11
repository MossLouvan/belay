// Unit tests for the session-kind helpers: which of the two shapes a session
// is, whether it can be attached, and what the list says about it.
//
//   cd app && node --test src/agent/session-kind.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachedLabel, isAttachable, kindLabel, pickKind, sessionKind } from './session-kind.ts';

const meta = (over = {}) => ({
  id: 'a', title: 'belay', cwd: '/p/belay', status: 'idle', lastUsed: 0, createdAt: 0, ...over,
});

test('the host\'s kind is taken at its word', () => {
  assert.equal(sessionKind(meta({ kind: 'pty' })), 'pty');
  assert.equal(sessionKind(meta({ kind: 'stream' })), 'stream');
});

test('a host from before attachable sessions means stream, not a guess', () => {
  // Every session an older host runs is stream-json. Defaulting the other way
  // would have the phone attach to a pty that does not exist.
  assert.equal(sessionKind(meta()), 'stream');
  assert.equal(sessionKind(meta({ kind: undefined })), 'stream');
  assert.equal(sessionKind(meta({ kind: 'something-new' })), 'stream');
  assert.equal(sessionKind(null), 'stream');
  assert.equal(sessionKind(undefined), 'stream');
});

test('only Belay\'s own pty sessions may be attached', () => {
  assert.equal(isAttachable(meta({ kind: 'pty' })), true);
  assert.equal(isAttachable(meta({ kind: 'stream' })), false);
  // A `claude` somebody started by typing it themselves is read-plus-approve
  // only: it has no Belay-owned pty, so there is nothing to attach to.
  assert.equal(isAttachable({ claudeSessionId: 'x', cwd: '/p', mtime: 0, preview: '' }), false);
  assert.equal(isAttachable(null), false);
});

test('each kind has a word, and they are different words', () => {
  assert.equal(kindLabel('pty'), 'terminal');
  assert.equal(kindLabel('stream'), 'guided');
  assert.notEqual(kindLabel('pty'), kindLabel('stream'));
});

test('a row counts every attached client, because none of them is this phone', () => {
  // The session view is closed while this list is on screen, so one attached
  // client is the terminal at the desk — exactly the thing worth saying.
  assert.equal(attachedLabel(meta({ kind: 'pty', attached: 1 })), '1 attached');
  assert.equal(attachedLabel(meta({ kind: 'pty', attached: 2 })), '2 attached');
});

test('a row says nothing about attachment when there is nothing to say', () => {
  assert.equal(attachedLabel(meta({ kind: 'pty', attached: 0 })), null, 'nobody is on it');
  assert.equal(attachedLabel(meta({ kind: 'pty' })), null, 'an older host sends no count');
  // A stream session has no pty, so any count on it is meaningless — never a
  // claim that somebody is watching.
  assert.equal(attachedLabel(meta({ kind: 'stream', attached: 4 })), null);
});

test('a kind is picked out of a list already in hand', () => {
  const list = [meta({ id: 'a', kind: 'pty' }), meta({ id: 'b', kind: 'stream' })];
  assert.equal(pickKind(list, 'a'), 'pty');
  assert.equal(pickKind(list, 'b'), 'stream');
});

test('a session not in the list is unknown, which is not the same as stream', () => {
  // Rendering the structured feed over a live terminal would show an empty
  // history where a running session should be, so the caller must fetch.
  assert.equal(pickKind([meta({ id: 'a', kind: 'pty' })], 'zzz'), null);
  assert.equal(pickKind(null, 'a'), null);
  assert.equal(pickKind(undefined, 'a'), null);
  assert.equal(pickKind([], 'a'), null);
});
