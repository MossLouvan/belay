// Unit tests for the return-to-foreground reattach decision (backlog item
// `auto-reattach-foreground`).
//
//   cd app && node --test src/foreground.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionReattachLink, shouldReattachOnForeground } from './foreground.ts';

// --- shouldReattachOnForeground ---------------------------------------------

test('only the active transition while waiting out a backoff fires', () => {
  assert.equal(shouldReattachOnForeground('active', 'waiting'), true);
});

test('a live link never double-fires on foreground', () => {
  assert.equal(shouldReattachOnForeground('active', 'live'), false);
});

test('an attempt already in flight is left to finish', () => {
  assert.equal(shouldReattachOnForeground('active', 'in-flight'), false);
});

test('a link that is off (or terminal) stays off', () => {
  assert.equal(shouldReattachOnForeground('active', 'off'), false);
});

test('leaving the foreground never fires, whatever the link state', () => {
  for (const state of ['background', 'inactive', 'unknown', 'extension', '']) {
    assert.equal(shouldReattachOnForeground(state, 'waiting'), false);
  }
});

// --- connectionReattachLink --------------------------------------------------

test('keep-trying off means no reattach interest at all', () => {
  assert.equal(connectionReattachLink(false, 'unreachable'), 'off');
  assert.equal(connectionReattachLink(false, 'connected'), 'off');
});

test('a connected computer is live — nothing to reattach', () => {
  assert.equal(connectionReattachLink(true, 'connected'), 'live');
});

test('a connect already racing addresses is in flight', () => {
  assert.equal(connectionReattachLink(true, 'connecting'), 'in-flight');
});

test('unreachable or idle is a wait worth cutting short', () => {
  assert.equal(connectionReattachLink(true, 'unreachable'), 'waiting');
  assert.equal(connectionReattachLink(true, 'idle'), 'waiting');
});

test('composed: foreground return cuts the wait only when one is pending', () => {
  assert.equal(shouldReattachOnForeground('active', connectionReattachLink(true, 'unreachable')), true);
  assert.equal(shouldReattachOnForeground('active', connectionReattachLink(true, 'connected')), false);
  assert.equal(shouldReattachOnForeground('background', connectionReattachLink(true, 'unreachable')), false);
});
