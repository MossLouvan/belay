// The rename shim: BELAY_* is canonical, TETHER_* still read.
//
// This is exactly the kind of glue that rots silently — nothing in normal
// development ever sets the legacy names, so only a test notices when a
// refactor drops the fallback and a working install breaks on update.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { productEnv } from '../src/env.js';

test('the canonical BELAY_* name is read', () => {
  assert.equal(productEnv('PORT', { BELAY_PORT: '9000' }), '9000');
});

test('the legacy TETHER_* name still works', () => {
  assert.equal(productEnv('PORT', { TETHER_PORT: '9000' }), '9000');
});

test('when both are set, the canonical name wins', () => {
  assert.equal(
    productEnv('PORT', { BELAY_PORT: '9001', TETHER_PORT: '9000' }),
    '9001',
  );
});

test('an empty canonical value still wins — set is set', () => {
  // Someone exporting BELAY_HOSTS="" means "no extra hosts", not
  // "please resurrect whatever TETHER_HOSTS said years ago".
  assert.equal(productEnv('HOSTS', { BELAY_HOSTS: '', TETHER_HOSTS: 'x' }), '');
});

test('neither set reads as undefined', () => {
  assert.equal(productEnv('PORT', {}), undefined);
});
