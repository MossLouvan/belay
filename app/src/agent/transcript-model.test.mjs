// Pure tests for the /ws/transcript wire and the read-only view's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_TRANSCRIPT, liveLabel, parseTranscriptMessage, reduceTranscript, watchLine,
} from './transcript-model.ts';
import { EVENT_CAP } from './model.ts';

const session = { claudeSessionId: 'c1', cwd: '/home/me/proj', preview: 'fix the tests' };
const ev = (t, text = 'x') => ({ t, kind: 'text', text });
const hello = (over = {}) => JSON.stringify({ type: 'hello', session, events: [ev(1)], offset: 120, live: true, lastWriteAt: 5000, ...over });

test('parseTranscriptMessage: hello carries session, events, offset, live', () => {
  const m = parseTranscriptMessage(hello());
  assert.equal(m.type, 'hello');
  assert.deepEqual(m.session, session);
  assert.equal(m.events.length, 1);
  assert.equal(m.events[0].kind, 'text');
  assert.equal(m.offset, 120);
  assert.equal(m.live, true);
  assert.equal(m.lastWriteAt, 5000);
});

test('parseTranscriptMessage: hello without a session or a numeric offset is dropped', () => {
  assert.equal(parseTranscriptMessage(hello({ session: {} })), null);
  assert.equal(parseTranscriptMessage(hello({ offset: '120' })), null);
});

test('parseTranscriptMessage: missing optional strings default to empty', () => {
  const m = parseTranscriptMessage(hello({ session: { claudeSessionId: 'c1' } }));
  assert.deepEqual(m.session, { claudeSessionId: 'c1', cwd: '', preview: '' });
});

test('parseTranscriptMessage: events frame drops malformed events, keeps the good ones', () => {
  const m = parseTranscriptMessage(JSON.stringify({
    type: 'events', events: [ev(2), { kind: 'nope' }, 'junk', ev(3)], offset: 300, live: true, lastWriteAt: 6000,
  }));
  assert.equal(m.type, 'events');
  assert.deepEqual(m.events.map((e) => e.t), [2, 3]);
  assert.equal(m.offset, 300);
});

test('parseTranscriptMessage: live and error frames; live is strictly boolean true', () => {
  assert.deepEqual(parseTranscriptMessage('{"type":"live","live":"yes","lastWriteAt":1}'), { type: 'live', live: false, lastWriteAt: 1 });
  assert.deepEqual(parseTranscriptMessage('{"type":"live","live":true,"lastWriteAt":"soon"}'), { type: 'live', live: true, lastWriteAt: 0 });
  assert.deepEqual(parseTranscriptMessage('{"type":"error","error":"gone"}'), { type: 'error', error: 'gone' });
  assert.equal(parseTranscriptMessage('{"type":"error"}').error, 'the host refused the transcript');
});

test('parseTranscriptMessage: junk, unknown types and non-objects are null', () => {
  assert.equal(parseTranscriptMessage('not json'), null);
  assert.equal(parseTranscriptMessage('42'), null);
  assert.equal(parseTranscriptMessage('{"type":"future"}'), null);
  assert.equal(parseTranscriptMessage(null), null);
});

test('reduceTranscript: hello opens the link, replaces state; events append; live flips', () => {
  let s = reduceTranscript(INITIAL_TRANSCRIPT, { type: 'note', note: 'old' });
  s = reduceTranscript(s, { type: 'message', message: parseTranscriptMessage(hello()) });
  assert.equal(s.link, 'open');
  assert.equal(s.note, '');
  assert.deepEqual(s.session, session);
  assert.equal(s.events.length, 1);

  s = reduceTranscript(s, { type: 'message', message: parseTranscriptMessage(JSON.stringify({ type: 'events', events: [ev(2)], offset: 200, live: true, lastWriteAt: 7000 })) });
  assert.deepEqual(s.events.map((e) => e.t), [1, 2]);
  assert.equal(s.offset, 200);
  assert.equal(s.lastWriteAt, 7000);

  const quiet = reduceTranscript(s, { type: 'message', message: { type: 'live', live: false, lastWriteAt: 7000 } });
  assert.equal(quiet.live, false);
  assert.equal(reduceTranscript(quiet, { type: 'message', message: { type: 'live', live: false, lastWriteAt: 7000 } }), quiet, 'no-op keeps identity');
});

test('reduceTranscript: an empty events frame keeps the array identity but moves the offset', () => {
  const s = reduceTranscript(INITIAL_TRANSCRIPT, { type: 'message', message: parseTranscriptMessage(hello()) });
  const next = reduceTranscript(s, { type: 'message', message: { type: 'events', events: [], offset: 999, live: false, lastWriteAt: 1 } });
  assert.equal(next.events, s.events);
  assert.equal(next.offset, 999);
});

test('reduceTranscript: the feed is capped at EVENT_CAP newest events', () => {
  const s = reduceTranscript(INITIAL_TRANSCRIPT, { type: 'message', message: parseTranscriptMessage(hello()) });
  const many = Array.from({ length: EVENT_CAP + 10 }, (_, i) => ev(100 + i));
  const next = reduceTranscript(s, { type: 'message', message: { type: 'events', events: many, offset: 1, live: true, lastWriteAt: 1 } });
  assert.equal(next.events.length, EVENT_CAP);
  assert.equal(next.events[next.events.length - 1].t, 100 + EVENT_CAP + 9);
});

test('reduceTranscript: error frame marks the link and keeps the note; link no-op keeps identity', () => {
  const s = reduceTranscript(INITIAL_TRANSCRIPT, { type: 'message', message: { type: 'error', error: 'denied' } });
  assert.equal(s.link, 'error');
  assert.equal(s.note, 'denied');
  assert.equal(reduceTranscript(s, { type: 'link', link: 'error' }), s);
});

test('watchLine: none until open with a session, then watching while live, quiet after', () => {
  assert.equal(watchLine(INITIAL_TRANSCRIPT), 'none');
  const open = reduceTranscript(INITIAL_TRANSCRIPT, { type: 'message', message: parseTranscriptMessage(hello()) });
  assert.equal(watchLine(open), 'watching');
  assert.equal(watchLine({ ...open, live: false }), 'quiet');
  assert.equal(watchLine({ ...open, link: 'closed' }), 'none');
});

test('liveLabel: LIVE mark, or quiet with the age', () => {
  const ago = (t, now) => `${Math.round((now - t) / 60000)}m ago`;
  assert.equal(liveLabel(true, 0, 0, ago), '● LIVE');
  assert.equal(liveLabel(false, 60_000, 300_000, ago), 'quiet · 4m ago');
  assert.equal(liveLabel(false, 0, 300_000, ago), 'quiet');
});
