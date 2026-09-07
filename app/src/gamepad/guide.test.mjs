import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyExit, exitHold, EXIT_HOLD_MS } from './guide.ts';

test('the Exit button hold reports progress and fires exactly once', () => {
  const begin = exitHold(emptyExit(), false, true, 100);
  assert.equal(exitHold(begin, false, true, 100 + EXIT_HOLD_MS / 2).progress, .5);
  assert.equal(exitHold(begin, false, true, 99 + EXIT_HOLD_MS).exit, false);
  const finish = exitHold(begin, false, true, 100 + EXIT_HOLD_MS);
  assert.equal(finish.exit, true);
  assert.equal(exitHold(finish, false, true, 3000).exit, false);
});
test('Guide shares the timing; release resets; bad clocks reset', () => {
  const begin = exitHold(emptyExit(), true, false, 0);
  assert.equal(exitHold(begin, true, false, EXIT_HOLD_MS).exit, true);
  assert.deepEqual(exitHold(begin, false, false, 300), emptyExit());
  assert.equal(exitHold(begin, true, false, -1).progress, 0);
  assert.deepEqual(exitHold(begin, true, false, NaN), emptyExit());
});
test('a quick tap never exits', () => {
  const begin = exitHold(emptyExit(), false, true, 0);
  assert.equal(exitHold(begin, false, true, 200).exit, false);
  assert.deepEqual(exitHold(begin, false, false, 250), emptyExit());
});
