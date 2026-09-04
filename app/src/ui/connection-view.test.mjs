// Unit tests for the one-voice status descriptor.
//
//   cd app && node --test src/ui/connection-view.test.mjs
//
// Pure mapping, no framework — same shape as the other suites here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeConnection, describeSurface } from './connection-view.ts';

// ---------------------------------------------------------------------------
// describeSurface — link alone (no surface phase)
// ---------------------------------------------------------------------------

test('connected link with no surface is LIVE, filled, good', () => {
  const v = describeSurface('connected');
  assert.deepEqual(v, { ring: false, status: 'good', word: 'Connected' });
});

test('connecting link is OPENING with a hollow ring in accent', () => {
  const v = describeSurface('connecting');
  assert.deepEqual(v, { ring: true, status: 'accent', word: 'Connecting' });
});

test('unreachable link is OFFLINE, filled bad, with the honest why', () => {
  const v = describeSurface('unreachable');
  assert.deepEqual(v, { ring: false, status: 'bad', word: 'Offline', detail: 'asleep or off' });
});

test('idle link is OFFLINE, filled neutral, no detail invented', () => {
  const v = describeSurface('idle');
  assert.deepEqual(v, { ring: false, status: 'neutral', word: 'Offline' });
});

// ---------------------------------------------------------------------------
// describeSurface — merge precedence: link-down beats surface-state
// ---------------------------------------------------------------------------

test('a surface may not say OFFLINE while the link is still connecting', () => {
  const v = describeSurface('connecting', 'offline');
  assert.equal(v.word, 'Connecting');
  assert.equal(v.ring, true);
});

test('a surface may not claim LIVE while the link is unreachable', () => {
  const v = describeSurface('unreachable', 'live');
  assert.equal(v.word, 'Offline');
  assert.equal(v.status, 'bad');
  assert.equal(v.ring, false);
});

test('an idle link silences every surface claim', () => {
  assert.equal(describeSurface('idle', 'live').word, 'Offline');
  assert.equal(describeSurface('idle', 'ended').word, 'Offline');
});

test('a reconnecting surface keeps its word through a link reconnect', () => {
  // The link re-races while the surface is already trying again: one voice,
  // and RECONNECTING is the truer of the two.
  const v = describeSurface('connecting', 'reconnecting');
  assert.deepEqual(v, { ring: true, status: 'warn', word: 'Reconnecting' });
});

// ---------------------------------------------------------------------------
// describeSurface — link up, surface speaks
// ---------------------------------------------------------------------------

test('link up: surface phases map onto the closed vocabulary', () => {
  assert.deepEqual(describeSurface('connected', 'live'), { ring: false, status: 'good', word: 'Connected' });
  assert.deepEqual(describeSurface('connected', 'opening'), { ring: true, status: 'accent', word: 'Connecting' });
  assert.deepEqual(describeSurface('connected', 'reconnecting'), { ring: true, status: 'warn', word: 'Reconnecting' });
  assert.deepEqual(describeSurface('connected', 'offline'), { ring: false, status: 'bad', word: 'Offline' });
});

test('link up: an ended shell is SHELL ENDED — calm warn, not an error', () => {
  const v = describeSurface('connected', 'ended');
  assert.deepEqual(v, { ring: false, status: 'warn', word: 'Shell ended' });
});

test('ring is true for exactly the transitioning words', () => {
  const words = ['idle', 'connecting', 'connected', 'unreachable'].flatMap((link) =>
    [undefined, 'live', 'opening', 'reconnecting', 'offline', 'ended'].map((s) => describeSurface(link, s)),
  );
  for (const v of words) {
    assert.equal(v.ring, v.word === 'Connecting' || v.word === 'Reconnecting', `${v.word} ring=${v.ring}`);
  }
});

// ---------------------------------------------------------------------------
// describeSurface — extras
// ---------------------------------------------------------------------------

test('paired:false wins over everything — NOT PAIRED, neutral, filled', () => {
  assert.deepEqual(describeSurface('connected', 'live', { paired: false }), {
    ring: false,
    status: 'neutral',
    word: 'Not paired',
  });
  assert.equal(describeSurface('connecting', undefined, { paired: false }).word, 'Not paired');
});

test('a caller detail rides along on a steady word', () => {
  const v = describeSurface('connected', 'live', { detail: '42 fps' });
  assert.equal(v.detail, '42 fps');
});

test('a caller detail overrides the default OFFLINE why', () => {
  const v = describeSurface('unreachable', undefined, { detail: 'wake it from the Mac' });
  assert.equal(v.detail, 'wake it from the Mac');
});

test('details are muted while transitioning — the ring already says it', () => {
  const v = describeSurface('connected', 'opening', { detail: 'stale' });
  assert.equal(v.detail, undefined);
});

// ---------------------------------------------------------------------------
// describeConnection — thin back-compat wrapper
// ---------------------------------------------------------------------------

test('describeConnection keeps its shape: status, pulse, label', () => {
  const v = describeConnection('connected', 'studio');
  assert.equal(v.status, 'good');
  assert.equal(v.pulse, false);
  assert.equal(v.label, 'Connected · studio');
});

test('describeConnection maps ring onto the legacy pulse flag', () => {
  const v = describeConnection('connecting', 'studio');
  assert.equal(v.status, 'accent');
  assert.equal(v.pulse, true);
  assert.equal(v.label, 'Connecting', 'the machine is not confirmed reachable while the race runs');
});

test('describeConnection speaks OFFLINE for unreachable, with the why', () => {
  const v = describeConnection('unreachable', 'studio');
  assert.equal(v.status, 'bad');
  assert.equal(v.label, 'Offline · asleep or off');
});

test('describeConnection idle drops every suffix rather than printing "undefined"', () => {
  assert.equal(describeConnection('idle').label, 'Offline');
  assert.equal(describeConnection('connected').label, 'Connected');
});
