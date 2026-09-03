// Tests for the approval-queue model: the "N more waiting" stack the phone
// shows under the approval card when Claude's parallel tool use raises more
// than one ask at once.
//
//   cd app && node --test src/agent/approval-queue.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_APPROVALS_WAITING, getApprovalsWaiting, parseApprovalsWaiting,
  setApprovalsWaiting, subscribeApprovalsWaiting, waitingLabel,
} from './approval-queue.ts';

const msg = (o) => JSON.stringify(o);

// ---- wire parsing -----------------------------------------------------------

test('parseApprovalsWaiting reads the approvals-waiting broadcast', () => {
  const w = parseApprovalsWaiting(msg({ type: 'approvals-waiting', waiting: 2, tools: ['Bash', 'Edit'] }));
  assert.deepEqual(w, { waiting: 2, tools: ['Bash', 'Edit'] });
});

test('other message types and non-strings parse to null, never to zero', () => {
  // Null means "this message says nothing about the queue" — collapsing it to
  // zero would clear the stack on every ordinary event broadcast.
  assert.equal(parseApprovalsWaiting(msg({ type: 'event', event: {} })), null);
  assert.equal(parseApprovalsWaiting(msg({ type: 'permission-clear' })), null);
  assert.equal(parseApprovalsWaiting(42), null);
  assert.equal(parseApprovalsWaiting('not json {'), null);
});

test('the hello snapshot also carries the stack, so a reconnect starts honest', () => {
  const w = parseApprovalsWaiting(msg({
    type: 'hello',
    session: { id: 'x', approvalsWaiting: { waiting: 1, tools: ['Write'] } },
  }));
  assert.deepEqual(w, { waiting: 1, tools: ['Write'] });
  // A hello without the field (an older host) resets to none rather than
  // leaving a stale count from the previous socket.
  assert.deepEqual(parseApprovalsWaiting(msg({ type: 'hello', session: { id: 'x' } })), NO_APPROVALS_WAITING);
});

test('malformed counts and tool lists degrade to nothing waiting, not garbage', () => {
  assert.deepEqual(
    parseApprovalsWaiting(msg({ type: 'approvals-waiting', waiting: 'many', tools: 'Bash' })),
    NO_APPROVALS_WAITING,
  );
  const w = parseApprovalsWaiting(msg({ type: 'approvals-waiting', waiting: 3, tools: ['Bash', 7, null, 'Edit'] }));
  assert.deepEqual(w, { waiting: 3, tools: ['Bash', 'Edit'] }, 'non-string tools are dropped, the count survives');
  const negative = parseApprovalsWaiting(msg({ type: 'approvals-waiting', waiting: -2, tools: [] }));
  assert.deepEqual(negative, NO_APPROVALS_WAITING);
});

// ---- the label --------------------------------------------------------------

test('waitingLabel says how many and which tools, and stays quiet at zero', () => {
  assert.equal(waitingLabel(NO_APPROVALS_WAITING), null);
  assert.equal(waitingLabel({ waiting: 1, tools: ['Bash'] }), '1 more waiting · Bash');
  assert.equal(waitingLabel({ waiting: 2, tools: ['Bash', 'Edit'] }), '2 more waiting · Bash · Edit');
});

test('waitingLabel caps the tool list rather than filling the card', () => {
  assert.equal(
    waitingLabel({ waiting: 5, tools: ['Bash', 'Edit', 'Write', 'Read', 'Glob'] }),
    '5 more waiting · Bash · Edit · Write · …',
  );
  assert.equal(waitingLabel({ waiting: 2, tools: [] }), '2 more waiting', 'a count with no names still counts');
});

// ---- the store --------------------------------------------------------------

test('the store notifies subscribers and skips no-op sets', () => {
  const seen = [];
  const unsubscribe = subscribeApprovalsWaiting(() => seen.push(getApprovalsWaiting()));
  setApprovalsWaiting({ waiting: 2, tools: ['Bash', 'Edit'] });
  setApprovalsWaiting({ waiting: 2, tools: ['Bash', 'Edit'] }); // identical — no re-render
  setApprovalsWaiting(NO_APPROVALS_WAITING);
  unsubscribe();
  setApprovalsWaiting({ waiting: 9, tools: [] }); // after unsubscribe — unheard
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { waiting: 2, tools: ['Bash', 'Edit'] });
  assert.deepEqual(seen[1], NO_APPROVALS_WAITING);
  setApprovalsWaiting(NO_APPROVALS_WAITING); // leave the module clean for other tests
});
