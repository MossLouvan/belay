import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTabPress } from './nav-plan.ts';

test('tapping the lit tab is a no-op', () => {
  assert.deepEqual(planTabPress('system', 'system'), { kind: 'stay' });
});

test('from the desktop, a tool tab pushes', () => {
  assert.deepEqual(planTabPress('screen', 'agent'), { kind: 'navigate', href: '/agent' });
});

test('inside a tool, Screen pops and another tool replaces', () => {
  assert.deepEqual(planTabPress('agent', 'screen'), { kind: 'back' });
  assert.deepEqual(planTabPress('agent', 'files'), { kind: 'replace', href: '/files' });
});

test('#73: with no tab lit (Computers list), every tab navigates — Screen included', () => {
  assert.deepEqual(planTabPress(undefined, 'screen'), { kind: 'navigate', href: '/screen' });
  assert.deepEqual(planTabPress(undefined, 'system'), { kind: 'navigate', href: '/system' });
});
