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
  flowAnswer, flowCancelQueued, flowDenyAll, flowDropQueued, flowExpire, flowInterrupt, flowPrompt,
  flowRequestApproval, flowTurnDone,
  flowRevokeGrant,
} from '../src/agent-flow.js';
import type { FlowIO, FlowSession } from '../src/agent-flow.js';

const CWD = mkdtempSync(join(tmpdir(), 'belay-flow-'));

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
    s: { id: 'sess', cwd: CWD, status, pending: undefined, approvalQueue: [], queued: undefined, grants: [] },
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

// ---- the approval queue -----------------------------------------------------
// Claude Code's parallel tool use makes two simultaneous asks routine. The
// second must wait its turn — visibly, with its own clock — never be denied
// for the crime of arriving second.

test('a second concurrent ask queues FIFO behind the first, visibly and with its own ping', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  assert.equal(h.s.pending?.detail, 'ls', 'the first ask stays on deck');
  assert.equal(h.s.approvalQueue.length, 1);
  assert.equal(h.s.approvalQueue[0]!.detail, 'pwd');
  assert.equal(h.pings.length, 2, 'each raised ask notifies — a queued ask can still time out unseen');
  const waiting = lastWire(h, 'approvals-waiting');
  assert.equal(waiting.waiting, 1, 'the phone hears how many are stacked');
  assert.deepEqual(waiting.tools, ['Bash']);
  assert.ok(h.feed.some((e) => e.kind === 'info' && e.text?.includes('also waiting')), 'the queue is visible in the feed');

  // Answering the first promotes the second — the phone gets a fresh card.
  flowAnswer(h.s, h.io, h.s.pending!.id, true);
  assert.equal((await first).allow, true);
  assert.equal(h.s.pending?.detail, 'pwd');
  assert.equal(h.s.status, 'waiting', 'still waiting: the next ask is on deck');
  assert.equal(lastWire(h, 'permission').request.detail, 'pwd');
  assert.equal(lastWire(h, 'approvals-waiting').waiting, 0);

  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  assert.equal((await second).allow, false);
  assert.equal(h.s.status, 'running');
  assert.ok(lastWire(h, 'permission-clear'), 'only an empty queue clears the card');
});

test('three asks resolve strictly in arrival order', async () => {
  const h = harness('idle');
  const verdicts = [
    flowRequestApproval(h.s, h.io, 'Bash', { command: 'a' }, 0, () => {}),
    flowRequestApproval(h.s, h.io, 'Bash', { command: 'b' }, 0, () => {}),
    flowRequestApproval(h.s, h.io, 'Bash', { command: 'c' }, 0, () => {}),
  ];
  const answered: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    answered.push(h.s.pending!.detail);
    flowAnswer(h.s, h.io, h.s.pending!.id, true);
  }
  assert.deepEqual(answered, ['a', 'b', 'c']);
  for (const v of verdicts) assert.equal((await v).allow, true);
  assert.equal(h.s.pending, undefined);
  assert.equal(h.s.status, 'running');
});

test('a queued ask can be answered by id without disturbing the head', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  const queuedId = h.s.approvalQueue[0]!.id;
  assert.equal(flowAnswer(h.s, h.io, queuedId, false), true);
  assert.equal((await second).allow, false);
  assert.equal(h.s.pending?.detail, 'ls', 'the head ask is untouched');
  assert.equal(h.s.status, 'waiting');
  assert.equal(h.s.approvalQueue.length, 0);
  assert.equal(lastWire(h, 'approvals-waiting').waiting, 0);
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  await first;
});

test('an unknown approval id still answers nothing', () => {
  const h = harness('idle');
  void flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  assert.equal(flowAnswer(h.s, h.io, 'not-a-real-id', true), false);
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
});

test('each queued ask fails closed on its own clock; the head is unaffected', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  const queuedId = h.s.approvalQueue[0]!.id;

  flowExpire(h.s, h.io, queuedId, 60_000);
  const v2 = await second;
  assert.equal(v2.allow, false, 'a queued ask that runs out of clock is denied — fail closed');
  assert.match(v2.message!, /absence, not refusal/);
  assert.equal(h.s.pending?.detail, 'ls', 'the head ask keeps waiting');
  assert.equal(h.s.status, 'waiting');
  assert.equal(h.pings.filter((p) => p.kind === 'expired').length, 1);
  assert.ok(h.feed.some((e) => e.kind === 'error' && e.text?.includes('nobody answered')));

  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  await first;
});

test('when the head expires the next ask is promoted, still waiting', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  flowExpire(h.s, h.io, h.s.pending!.id, 60_000);
  assert.equal((await first).allow, false);
  assert.equal(h.s.pending?.detail, 'pwd');
  assert.equal(h.s.status, 'waiting', 'the session is not "running" while an ask still waits');
  assert.equal(lastWire(h, 'permission').request.detail, 'pwd');
  flowAnswer(h.s, h.io, h.s.pending!.id, false);
  await second;
});

test('a grant minted on the head auto-allows the queued duplicate at promotion — visibly', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'npm test' }, 0, () => {});
  flowAnswer(h.s, h.io, h.s.pending!.id, true, { choiceId: 'exact-command' });
  assert.equal((await first).allow, true);
  assert.equal((await second).allow, true, 'the duplicate rides the grant its twin just minted');
  assert.equal(h.s.pending, undefined);
  assert.equal(h.s.status, 'running');
  assert.ok(h.feed.some((e) => e.kind === 'info' && e.text?.startsWith('allowed without asking')));
  assert.ok(lastWire(h, 'permission-clear'));
});

test('interrupt while waiting denies the whole stack and steers with the message', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  assert.equal(flowInterrupt(h.s, h.io, 'do something else'), 'steered');
  const [v1, v2] = [await first, await second];
  assert.equal(v1.allow, false);
  assert.equal(v2.allow, false);
  assert.ok(v2.message?.includes('do something else'), 'the steer reaches every blocked tool call');
  assert.equal(h.s.pending, undefined);
  assert.equal(h.s.approvalQueue.length, 0);
  assert.equal(h.s.status, 'running');
  assert.equal(lastWire(h, 'approvals-waiting').waiting, 0);
});

test('flowDenyAll fails the whole stack closed — the stop/exit path', async () => {
  const h = harness('idle');
  const first = flowRequestApproval(h.s, h.io, 'Bash', { command: 'ls' }, 0, () => {});
  const second = flowRequestApproval(h.s, h.io, 'Bash', { command: 'pwd' }, 0, () => {});
  assert.equal(flowDenyAll(h.s, h.io, 'session process exited'), true);
  assert.equal((await first).allow, false);
  assert.equal((await second).message, 'session process exited');
  assert.equal(h.s.pending, undefined);
  assert.equal(h.s.approvalQueue.length, 0);
  assert.ok(lastWire(h, 'permission-clear'));
  assert.equal(flowDenyAll(h.s, h.io, 'nothing left'), false);
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
