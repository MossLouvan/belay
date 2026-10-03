import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ownerAuthNotice } from '../src/host-status.js';

test('a refused owner check becomes "Not approved", a passed one clears it', () => {
  assert.equal(ownerAuthNotice({ type: 'owner-auth', action: 'pair-decide', ok: false, error: 'Canceled by user.' }), 'Not approved. Canceled by user.');
  assert.equal(ownerAuthNotice({ type: 'owner-auth', action: 'pair-code', ok: false }), 'Not approved.');
  assert.equal(ownerAuthNotice({ type: 'owner-auth', action: 'pair-code', ok: true }), null);
});

test('the error is clamped to one short plain line', () => {
  const n = ownerAuthNotice({ type: 'owner-auth', ok: false, error: `x\u0000\n${'y'.repeat(500)}` });
  assert.ok(n.length <= 'Not approved. '.length + 120);
  assert.doesNotMatch(n, /[\u0000-\u001f]/);
});
