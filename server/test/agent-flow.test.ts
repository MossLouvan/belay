// The queue / interrupt / approval state machine, driven through a stub IO —
// no claude process, no websocket. The properties under test are the ones a
// user would call betrayal if they broke: a queued prompt is visible and
// cancellable and fires exactly once; an interrupt steers rather than
// refuses; "always" mints only the grant whose label was tapped; the legacy
// bare boolean no longer opens a whole tool; and an ask a grant swallows
// still leaves a visible line behind.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  flowAnswer, flowCancelQueued, flowDropQueued, flowInterrupt, flowPrompt,
  flowRequestApproval, flowTurnDone,
  flowRevokeGrant,
} from '../src/agent-flow.js';
import type { FlowIO, FlowSession } from '../src/agent-flow.js';

const CWD = mkdtempSync(join(tmpdir(), 'tether-flow-'));

interface Harness {
  s: FlowSession;
  io: FlowIO;
  feed: { kind: string; text?: string }[];
  wire: any[];
  delivered: string[];
  interrupts: number;
  pings: any[];
}

function harness(status: FlowSession['status'] = 'idle'): Harness {
  const h: Harness = {
    feed: [], wire: [], delivered: [], interrupts: 0, pings: [],
    s: { id: 'sess', cwd: CWD, status, pending: undefined, queued: undefined, grants: [] },
    io: undefined as unknown as FlowIO,
  };
  h.io = {
    push: (ev) => h.feed.push({ kind: ev.kind, text: ev.text }),
    send: (msg) => h.wire.push(msg),
    setStatus: (st) => { h.s.status = st; },
    deliver: (text) => { h.delivered.push(text); },
    interruptTurn: () => { h.interrupts += 1; },
    ping: (ev) => h.pings.push(ev),
  };
  return h;
}

const lastWire = (h: Harness, type: string) => [...h.wire].reverse().find((m) => m.type === type);

// ---- queue ------------------------------------------------------------------

test('an idle session sends immediately; a busy one queues, visibly', () => {
  const h = harness('idle');
  assert.equal(flowPrompt(h.s, h.io, 'first'), 'sent');
  assert.deepEqual(h.delivered, ['first']);
  assert.equal(h.s.status, 'running');

  assert.equal(flowPrompt(h.s, h.io, 'second'), 'queued');
  assert.deepEqual(h.delivered, ['first'], 'nothing reaches claude while a turn runs');
  assert.equal(h.s.queued?.text, 'second');
  assert.equal(lastWire(h, 'queued').queued.text, 'second', 'the queue is broadcast, so the phone can show and cancel it');
});

test('a second queued prompt replaces the first — latest intent wins, on the wire too', () => {
  const h = harness('running');
  flowPrompt(h.s, h.io, 'old plan');
  flowPrompt(h.s, h.io, 'new plan');
  assert.equal(h.s.queued?.text, 'new plan');
  assert.equal(lastWire(h, 'queued').queued.text, 'new plan');
});

test('the queued prompt fires exactly once when the turn ends', () => {
  const h = harness('running');
  flowPrompt(h.s, h.io, 'later');
  assert.equal(flowTurnDone(h.s, h.io), true);
  assert.deepEqual(h.delivered, ['later']);
  assert.equal(h.s.status, 'running');
  assert.equal(h.s.queued, undefined);
  assert.equal(lastWire(h, 'queued').queued, null);
  // The next turn end finds no queue and settles to idle.
  assert.equal(flowTurnDone(h.s, h.io), false);
  assert.equal(h.s.status, 'idle');
  assert.deepEqual(h.delivered, ['later']);
});

test('cancelling the queue works and is visible; stop drops it with a reason', () => {
  const h = harness('running');
  flowPrompt(h.s, h.io, 'later');
  assert.equal(flowCancelQueued(h.s, h.io), true);
  assert.equal(h.s.queued, undefined);
  assert.equal(lastWire(h, 'queued').queued, null);
  assert.equal(flowCancelQueued(h.s, h.io), false, 'nothing left to cancel');

  flowPrompt(h.s, h.io, 'later again');
  flowDropQueued(h.s, h.io, 'stopped from phone');
  assert.equal(h.s.queued, undefined);
  assert.ok(h.feed.some((e) => e.kind === 'info' && e.text?.includes('dropped')));
  // A cancelled queue must not fire.
  assert.equal(flowTurnDone(h.s, h.io), false);
  assert.deepEqual(h.delivered, []);
});

// ---- interrupt --------------------------------------------------------------

test('interrupt while running halts the turn and parks the message in the queue', () => {
  const h = harness('running');
  assert.equal(flowInterrupt(h.s, h.io, 'no, fix the import instead'), 'interrupted');
  assert.equal(h.interrupts, 1);
  assert.equal(h.s.queued?.text, 'no, fix the import instead');
  // The halt lands as a turn end; the message goes out then.
  assert.equal(flowTurnDone(h.s, h.io), true);
  assert.deepEqual(h.delivered, ['no, fix the import instead']);
});

test('interrupt while waiting denies the ask and steers with the message', async () => {
  const h = harness('idle');
  const verdict = flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm run build' }, 0, () => {});
  assert.equal(h.s.status, 'waiting');
  assert.equal(flowInterrupt(h.s, h.io, 'stop building, run the tests'), 'steered');
  const v = await verdict;
  assert.equal(v.allow, false);
  assert.ok(v.message?.includes('stop building, run the tests'), 'the words reach claude in the denial');
  assert.equal(h.s.pending, undefined);
  assert.equal(h.s.status, 'running');
  assert.equal(h.s.queued, undefined, 'steering rides the denial; nothing double-sends');
  assert.ok(h.feed.some((e) => e.kind === 'user' && e.text === 'stop building, run the tests'));
});

test('interrupt on an idle session is just a prompt', () => {
  const h = harness('idle');
  assert.equal(flowInterrupt(h.s, h.io, 'hello'), 'sent');
  assert.deepEqual(h.delivered, ['hello']);
});

// ---- approvals and grants ---------------------------------------------------

test('an approval raises, pings after raising, and a plain allow grants nothing', async () => {
  const h = harness('idle');
  const verdict = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const raised = lastWire(h, 'permission');
  assert.equal(raised.request.tool, 'Bash');
  assert.equal(raised.request.risk, 'run');
  assert.equal(raised.request.choices[0].id, 'exact-command');
  assert.equal(raised.request.preview.kind, 'command');
  assert.equal(h.pings.length, 1, 'the webhook fired once, after the ask was waiting');

  assert.equal(flowAnswer(h.s, h.io, raised.request.id, true), true);
  assert.equal((await verdict).allow, true);
  assert.deepEqual(h.s.grants, [], 'Allow is one-time');
});

test('a scoped answer mints exactly the tapped grant, and it then auto-allows with a visible line', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test' }, 0, () => {});
  const ask = lastWire(h, 'permission').request;
  flowAnswer(h.s, h.io, ask.id, true, { choiceId: 'exact-command' });
  assert.equal((await first).allow, true);
  assert.equal(h.s.grants.length, 1);
  assert.equal(h.s.grants[0]!.scope, 'exact-command');
  assert.ok(lastWire(h, 'grants').grants[0].label.includes('npm test'), 'grants are broadcast for the chips');

  // Same command again: allowed with no ask, no ping — but never silently.
  h.s.status = 'idle';
  const pings = h.pings.length;
  const again = await flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test' }, 0, () => {});
  assert.equal(again.allow, true);
  assert.equal(h.pings.length, pings, 'no notification for an ask the user never sees');
  assert.ok(h.feed.some((e) => e.kind === 'info' && e.text?.startsWith('allowed without asking')));

  // A different command is outside the grant and must ask again.
  const different = flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test -- --watch' }, 0, () => {});
  assert.equal(h.s.status, 'waiting');
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  assert.equal((await different).allow, false);
});

test('the legacy always boolean narrows to the narrowest choice, never the tool', async () => {
  const h = harness('idle');
  const verdict = flowRequestApproval(h.s, h.io, 'Bash', { command: 'git status' }, 0, () => {});
  flowAnswer(h.s, h.io, h.s.pending!.id, true, { legacyAlways: true });
  assert.equal((await verdict).allow, true);
  assert.equal(h.s.grants.length, 1);
  assert.equal(h.s.grants[0]!.scope, 'exact-command');
  assert.equal(h.s.grants[0]!.value, 'git status');

  // The grant covers a repeat but nothing else about the tool.
  h.s.status = 'idle';
  const other = flowRequestApproval(h.s, h.io, 'Bash', { command: 'git push --force' }, 0, () => {});
  assert.equal(h.s.status, 'waiting', 'a forced push still asks');
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  await other;
});

test('a danger-tier ask offers no choices, and always-spellings decay to allow-once', async () => {
  const h = harness('idle');
  const verdict = flowRequestApproval(h.s, h.io, 'Bash', { command: 'rm -rf dist' }, 0, () => {});
  const ask = lastWire(h, 'permission').request;
  assert.equal(ask.risk, 'danger');
  assert.deepEqual(ask.choices, []);
  flowAnswer(h.s, h.io, ask.id, true, { legacyAlways: true, choiceId: 'exact-command' });
  assert.equal((await verdict).allow, true);
  assert.deepEqual(h.s.grants, [], 'no standing permission for a destructive command');
});

test('a forged choice id grants nothing but still answers', async () => {
  const h = harness('idle');
  const verdict = flowRequestApproval(h.s, h.io, 'Read', { file_path: join(CWD, 'a.ts') }, 0, () => {});
  flowAnswer(h.s, h.io, h.s.pending!.id, true, { choiceId: 'everything-forever' });
  assert.equal((await verdict).allow, true);
  assert.deepEqual(h.s.grants, []);
});

test('revoking a grant re-arms the ask', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test' }, 0, () => {});
  flowAnswer(h.s, h.io, h.s.pending!.id, true, { choiceId: 'exact-command' });
  await first;
  const id = h.s.grants[0]!.id;
  assert.equal(flowRevokeGrant(h.s, h.io, id), true);
  assert.deepEqual(h.s.grants, []);
  assert.deepEqual(lastWire(h, 'grants').grants, []);
  assert.equal(flowRevokeGrant(h.s, h.io, id), false);

  h.s.status = 'idle';
  void flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test' }, 0, () => {});
  assert.equal(h.s.status, 'waiting', 'the revoked command asks again');
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
});

test('a second concurrent ask fails closed instead of queueing', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = await flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  assert.equal(second.allow, false);
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  await first;
});

test('an Edit ask carries a diff-ready preview; a Write says when it replaces a file', async () => {
  const h = harness('idle');
  const editAsk = flowRequestApproval(h.s, h.io, 'Edit', {
    file_path: join(CWD, 'x.ts'), old_string: 'const a = 1;', new_string: 'const a = 2;',
  }, 0, () => {});
  const edit = lastWire(h, 'permission').request;
  assert.equal(edit.preview.kind, 'edit');
  assert.equal(edit.preview.oldText, 'const a = 1;');
  assert.equal(edit.preview.newText, 'const a = 2;');
  flowAnswer(h.s, h.io, edit.id, false);
  await editAsk;

  h.s.status = 'idle';
  const writeAsk = flowRequestApproval(h.s, h.io, 'Write', {
    file_path: join(CWD, 'brand-new.ts'), content: 'hello\n',
  }, 0, () => {});
  const write = lastWire(h, 'permission').request;
  assert.equal(write.preview.kind, 'write');
  assert.equal(write.preview.exists, false, 'a fresh file is an addition, not a replacement');
  flowAnswer(h.s, h.io, write.id, false);
  await writeAsk;
});
