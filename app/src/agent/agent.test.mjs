// Unit tests for the Agent tab's pure model: wire-protocol parsing, the
// session reducer and the formatting helpers.
//
//   cd app && node --test src/agent/agent.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions. Only
// JSX-free modules are imported, since Node strips types but does not compile
// JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_CAP, INITIAL_SESSION, ago, appendTranscript, canPrompt, groupDiscovered, parseAgentMessage,
  parseEvent, parseSnapshot, projectName, reduceSession, resultSummary, statusLabel, statusTone,
} from './model.ts';

const snapshot = {
  id: 'abc123',
  title: 'tether',
  cwd: 'C:\\Users\\me\\tether',
  status: 'idle',
  lastUsed: 1000,
  createdAt: 900,
  events: [{ t: 1, kind: 'user', text: 'hi' }],
  pending: null,
};

const msg = (o) => JSON.stringify(o);

// ---- parsing ---------------------------------------------------------------

test('parses every message type the host sends', () => {
  assert.equal(parseAgentMessage(msg({ type: 'hello', session: snapshot })).type, 'hello');
  assert.deepEqual(parseAgentMessage(msg({ type: 'status', status: 'running' })), { type: 'status', status: 'running' });
  assert.deepEqual(parseAgentMessage(msg({ type: 'permission-clear' })), { type: 'permission-clear' });
  assert.deepEqual(parseAgentMessage(msg({ type: 'error', error: 'busy' })), { type: 'error', error: 'busy' });
  const ask = parseAgentMessage(msg({ type: 'permission', request: { id: 'p1', tool: 'Bash', detail: 'rm -rf', input: '{}' } }));
  assert.deepEqual(ask, { type: 'permission', request: { id: 'p1', tool: 'Bash', detail: 'rm -rf', input: '{}', expiresAt: undefined } });
  // The deadline rides along when the host sends one; junk deadlines are dropped.
  const timed = parseAgentMessage(msg({ type: 'permission', request: { id: 'p2', tool: 'Bash', detail: '', input: '{}', expiresAt: 1234 } }));
  assert.equal(timed.request.expiresAt, 1234);
  const junk = parseAgentMessage(msg({ type: 'permission', request: { id: 'p3', tool: 'Bash', detail: '', input: '{}', expiresAt: 'soon' } }));
  assert.equal(junk.request.expiresAt, undefined);
});

test('rejects garbage instead of rendering it', () => {
  assert.equal(parseAgentMessage('not json'), null);
  assert.equal(parseAgentMessage(42), null);
  assert.equal(parseAgentMessage(msg({ type: 'status', status: 'exploded' })), null);
  assert.equal(parseAgentMessage(msg({ type: 'permission', request: { tool: 'Bash' } })), null, 'an ask without an id cannot be answered');
  assert.equal(parseAgentMessage(msg({ type: 'hello', session: { title: 'x' } })), null);
  assert.equal(parseAgentMessage(msg({ type: 'mystery' })), null);
  assert.equal(parseEvent({ kind: 'thinking' }), null);
});

test('a snapshot drops malformed events but keeps the rest', () => {
  const snap = parseSnapshot({ ...snapshot, events: [{ kind: 'text', text: 'ok' }, { kind: 'nope' }, 'junk'] });
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].text, 'ok');
  assert.equal(typeof snap.events[0].t, 'number', 'a missing timestamp is filled in');
});

// ---- reducer ---------------------------------------------------------------

test('hello replaces the view with the host snapshot and opens the link', () => {
  const s = reduceSession(INITIAL_SESSION, { type: 'message', message: parseAgentMessage(msg({ type: 'hello', session: { ...snapshot, status: 'waiting', pending: { id: 'p1', tool: 'Edit', detail: 'a.ts', input: '{}' } } })) });
  assert.equal(s.link, 'open');
  assert.equal(s.status, 'waiting');
  assert.equal(s.pending.id, 'p1');
  assert.equal(s.events.length, 1);
  assert.equal(s.snapshot.title, 'tether');
});

test('events append and the feed is capped at EVENT_CAP', () => {
  let s = INITIAL_SESSION;
  for (let i = 0; i < EVENT_CAP + 10; i++) {
    s = reduceSession(s, { type: 'message', message: { type: 'event', event: { t: i, kind: 'info', text: String(i) } } });
  }
  assert.equal(s.events.length, EVENT_CAP);
  assert.equal(s.events[0].text, '10', 'the oldest lines are the ones dropped');
  assert.equal(s.events[EVENT_CAP - 1].text, String(EVENT_CAP + 9));
});

test('a permission ask flips status to waiting and clears on answer', () => {
  let s = reduceSession(INITIAL_SESSION, { type: 'message', message: { type: 'status', status: 'running' } });
  s = reduceSession(s, { type: 'message', message: { type: 'permission', request: { id: 'p2', tool: 'Bash', detail: 'ls', input: '{}' } } });
  assert.equal(s.status, 'waiting');
  assert.equal(s.pending.tool, 'Bash');
  s = reduceSession(s, { type: 'message', message: { type: 'permission-clear' } });
  assert.equal(s.pending, null);
});

test('unchanged status and link actions return the same object', () => {
  const s = reduceSession(INITIAL_SESSION, { type: 'link', link: 'connecting' });
  assert.equal(s, INITIAL_SESSION);
  const t = reduceSession(INITIAL_SESSION, { type: 'message', message: { type: 'status', status: 'idle' } });
  assert.equal(t, INITIAL_SESSION);
});

test('prompting is refused while the host is busy or the link is down', () => {
  const open = reduceSession(INITIAL_SESSION, { type: 'link', link: 'open' });
  assert.equal(canPrompt(open), true);
  assert.equal(canPrompt(reduceSession(open, { type: 'message', message: { type: 'status', status: 'running' } })), false);
  assert.equal(canPrompt(reduceSession(open, { type: 'message', message: { type: 'status', status: 'waiting' } })), false);
  assert.equal(canPrompt(reduceSession(open, { type: 'link', link: 'closed' })), false);
  assert.equal(canPrompt(INITIAL_SESSION), false, 'still connecting');
});

test('host errors land in the note', () => {
  const s = reduceSession(INITIAL_SESSION, { type: 'message', message: { type: 'error', error: 'session is busy' } });
  assert.equal(s.note, 'session is busy');
});

// ---- helpers ---------------------------------------------------------------

test('status tone and label', () => {
  assert.equal(statusTone('running'), 'warn');
  assert.equal(statusTone('waiting'), 'accent');
  assert.equal(statusTone('error'), 'bad');
  assert.equal(statusTone('idle'), 'good');
  assert.equal(statusLabel('waiting'), 'needs approval');
});

test('ago is coarse and human', () => {
  const now = 10_000_000_000;
  assert.equal(ago(now - 10_000, now), 'now');
  assert.equal(ago(now - 5 * 60_000, now), '5m ago');
  assert.equal(ago(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(ago(now - 5 * 86_400_000, now), '5d ago');
});

test('projectName takes the last segment on either separator', () => {
  assert.equal(projectName('C:\\Users\\me\\tether'), 'tether');
  assert.equal(projectName('/home/me/tether/'), 'tether');
  assert.equal(projectName(''), '');
});

test('resultSummary skips missing bits', () => {
  assert.equal(resultSummary({ t: 0, kind: 'result', ok: true, durationMs: 12_400, costUsd: 0.08 }), '✓ done · 12s · $0.08');
  assert.equal(resultSummary({ t: 0, kind: 'result', ok: false }), '✗ failed');
});

test('discovered sessions group by folder in arrival order', () => {
  const groups = groupDiscovered([
    { claudeSessionId: '1', cwd: '/a', mtime: 3, preview: 'x' },
    { claudeSessionId: '2', cwd: '/b', mtime: 2, preview: 'y' },
    { claudeSessionId: '3', cwd: '/a', mtime: 1, preview: 'z' },
  ]);
  assert.deepEqual(groups.map((g) => g.cwd), ['/a', '/b']);
  assert.deepEqual(groups[0].sessions.map((s) => s.claudeSessionId), ['1', '3']);
  assert.equal(groups[0].name, 'a');
});

test('appendTranscript joins with one space and ignores empty clips', () => {
  assert.equal(appendTranscript('', 'hello'), 'hello');
  assert.equal(appendTranscript('fix the ', ' build'), 'fix the build');
  assert.equal(appendTranscript('keep', '   '), 'keep');
});
