import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideHold, emptyGuide } from './guide.ts';
test('Guide exits once after one second, release or disconnect cancels/rearms', () => {
  const pressed = guideHold(emptyGuide(), true, 10);
  assert.equal(guideHold(pressed, true, 1009).exit, false);
  const held = guideHold(pressed, true, 1010);
  assert.equal(held.exit, true);
  assert.equal(guideHold(held, true, 2010).exit, false);
  const released = guideHold(pressed, false, 100);
  assert.deepEqual(released, emptyGuide());
  assert.equal(guideHold(released, true, 2000).exit, false);
  assert.deepEqual(guideHold(pressed, 'true', 2000), emptyGuide());
});
