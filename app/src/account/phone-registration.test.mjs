// POST /devices registers this phone's node id. The stub registration (a
// random placeholder) must be redone once the real FFI node id exists.
//
//   cd app && node --test src/account/phone-registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePhoneRegistration, registrationNeeded, serializePhoneRegistration } from './phone-registration.ts';

const NODE = 'ab'.repeat(32);

test('a stored registration round-trips', () => {
  const raw = serializePhoneRegistration({ id: 'dev-1', nodeId: NODE });
  assert.deepEqual(parsePhoneRegistration(raw), { id: 'dev-1', nodeId: NODE });
});

test('the stub era stored a bare id: that reads as no registration', () => {
  assert.equal(parsePhoneRegistration('dev-1'), null);
  assert.equal(parsePhoneRegistration(null), null);
  assert.equal(parsePhoneRegistration('{"id":1}'), null);
});

test('registration is needed when nothing is stored or the node id changed', () => {
  assert.equal(registrationNeeded(null, NODE), true);
  assert.equal(registrationNeeded({ id: 'dev-1', nodeId: 'cd'.repeat(32) }, NODE), true);
  assert.equal(registrationNeeded({ id: 'dev-1', nodeId: NODE }, NODE), false);
});
