import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyExit, exitHold, EXIT_HOLD_MS, EXIT_CHORD } from './guide.ts';

test('universal exit requires both menu buttons held, reports progress, and fires once', () => {
  const begin = exitHold(emptyExit(), EXIT_CHORD, false, false, 100);
  assert.equal(begin.suppress, true);
  assert.equal(exitHold(begin, EXIT_CHORD, false, false, 100 + EXIT_HOLD_MS / 2).progress, .5);
  assert.equal(exitHold(begin, EXIT_CHORD, false, false, 99 + EXIT_HOLD_MS).exit, false);
  const finish = exitHold(begin, EXIT_CHORD, false, false, 100 + EXIT_HOLD_MS);
  assert.equal(finish.exit, true);
  assert.equal(exitHold(finish, EXIT_CHORD, false, false, 3000).exit, false);
});
test('cancelled chord stays suppressed until both menu buttons release', () => {
  const begin = exitHold(emptyExit(), EXIT_CHORD, false, false, 100);
  const cancelled = exitHold(begin, 16, false, false, 200);
  assert.equal(cancelled.progress, 0);
  assert.equal(cancelled.suppress, true);
  assert.equal(cancelled.exit, false);
  assert.equal(exitHold(cancelled, 0, false, false, 300).suppress, false);
  assert.equal(exitHold(emptyExit(), 16, false, false, 5000).suppress, false);
});
test('Guide and accessible phone hold share timing and release resets progress', () => {
  for (const [guide, touch] of [[true, false], [false, true]]) {
    const begin = exitHold(emptyExit(), 0, guide, touch, 0);
    assert.equal(exitHold(begin, 0, guide, touch, EXIT_HOLD_MS).exit, true);
    assert.deepEqual(exitHold(begin, 0, false, false, 300), emptyExit());
    assert.equal(exitHold(begin, 0, guide, touch, -1).progress, 0);
  }
});
