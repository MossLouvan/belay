// Unit tests for the `/ws/agent-attach` model: the wire parser, the reducer,
// the negotiated-size note, and the reconnect policy.
//
//   cd app && node --test src/agent/attach-model.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, and
// only JSX-free modules, since Node strips types but does not compile JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INITIAL_ATTACH, RETRY_DELAYS_MS, attachedNote, effectiveAttached, linkLabel,
  othersAttached, parseAttachMessage, reduceAttach, retryDelay, shouldReattach, sizeNote,
} from './attach-model.ts';

const json = (o) => JSON.stringify(o);
const fold = (actions, start = INITIAL_ATTACH) =>
  actions.reduce((state, action) => reduceAttach(state, action), start);
const message = (m) => ({ type: 'message', message: m });
const ready = (over = {}) =>
  message({
    type: 'ready', mode: 'pty', cols: 80, rows: 24, attached: 1,
    session: { id: 's1', title: 'belay', cwd: '/p/belay' },
    ...over,
  });

// ---- parsing ---------------------------------------------------------------

test('a ready frame parses with its size, client count and session', () => {
  const msg = parseAttachMessage(json({
    type: 'ready', mode: 'pty', cols: 100, rows: 30, attached: 2,
    session: { id: 'abc', title: 'belay', cwd: '/p/belay' },
  }));
  assert.deepEqual(msg, {
    type: 'ready', mode: 'pty', cols: 100, rows: 30, attached: 2,
    session: { id: 'abc', title: 'belay', cwd: '/p/belay' },
  });
});

test('a ready without a usable size is refused rather than guessed at', () => {
  // Laying out to a guessed width draws a screenful of wrongly wrapped garbage,
  // which is worse than waiting for a handshake that makes sense.
  assert.equal(parseAttachMessage(json({ type: 'ready', cols: 0, rows: 24 })), null);
  assert.equal(parseAttachMessage(json({ type: 'ready', cols: 80 })), null);
  assert.equal(parseAttachMessage(json({ type: 'ready', cols: '80', rows: '24' })), null);
});

test('a ready degrades gracefully around the optional parts', () => {
  const msg = parseAttachMessage(json({ type: 'ready', cols: 80, rows: 24 }));
  assert.equal(msg.attached, 1, 'a missing count means only this client');
  assert.equal(msg.mode, 'pty');
  assert.equal(msg.session, null);
  const partial = parseAttachMessage(json({ type: 'ready', cols: 80, rows: 24, session: { id: 'x' } }));
  assert.deepEqual(partial.session, { id: 'x', title: 'session', cwd: '' });
});

test('data, resize, exit and error frames parse', () => {
  assert.deepEqual(parseAttachMessage(json({ type: 'data', data: 'hi' })), { type: 'data', data: 'hi' });
  assert.deepEqual(parseAttachMessage(json({ type: 'data', data: '' })), { type: 'data', data: '' });
  assert.deepEqual(parseAttachMessage(json({ type: 'resize', cols: 40, rows: 10 })), { type: 'resize', cols: 40, rows: 10 });
  assert.deepEqual(parseAttachMessage(json({ type: 'exit' })), { type: 'exit' });
  assert.deepEqual(parseAttachMessage(json({ type: 'error', error: 'no such session' })), { type: 'error', error: 'no such session' });
  assert.equal(parseAttachMessage(json({ type: 'error' })).error.length > 0, true, 'an error always says something');
});

test('malformed and unknown frames are dropped, never rendered as garbage', () => {
  assert.equal(parseAttachMessage('not json'), null);
  assert.equal(parseAttachMessage(json({ type: 'data' })), null, 'data with no string payload');
  assert.equal(parseAttachMessage(json({ type: 'resize', cols: -5, rows: 10 })), null);
  assert.equal(parseAttachMessage(json({ type: 'invented' })), null);
  assert.equal(parseAttachMessage(json(['ready'])), null);
  assert.equal(parseAttachMessage(json(null)), null);
  assert.equal(parseAttachMessage(42), null, 'only strings come off a socket');
});

// ---- the handshake ---------------------------------------------------------

test('ready opens the link and adopts the size the host granted', () => {
  const state = fold([ready({ cols: 100, rows: 30, attached: 2 })]);
  assert.equal(state.link, 'open');
  assert.equal(state.ready, true);
  assert.deepEqual(state.size, { cols: 100, rows: 30 });
  assert.equal(state.attached, 2);
  assert.deepEqual(state.session, { id: 's1', title: 'belay', cwd: '/p/belay' });
});

test('data frames leave the state alone — the screen buffer is not in here', () => {
  const open = fold([ready()]);
  assert.equal(reduceAttach(open, message({ type: 'data', data: 'lots of output' })), open);
});

test('the state is never mutated in place', () => {
  const before = fold([ready()]);
  const snapshot = JSON.parse(JSON.stringify(before));
  reduceAttach(before, message({ type: 'resize', cols: 40, rows: 12 }));
  assert.deepEqual(JSON.parse(JSON.stringify(before)), snapshot);
});

// ---- the negotiated resize -------------------------------------------------

test('a host resize is adopted verbatim, shrinking or growing', () => {
  const shrunk = fold([ready(), message({ type: 'resize', cols: 60, rows: 18 })]);
  assert.deepEqual(shrunk.size, { cols: 60, rows: 18 });
  const grown = reduceAttach(shrunk, message({ type: 'resize', cols: 120, rows: 40 }));
  assert.deepEqual(grown.size, { cols: 120, rows: 40 });
});

test('a resize to the size already held is not a new state', () => {
  const open = fold([ready({ cols: 80, rows: 24 })]);
  assert.equal(reduceAttach(open, message({ type: 'resize', cols: 80, rows: 24 })), open);
});

test('being driven smaller by another client is named, quietly', () => {
  const state = fold([
    { type: 'requested', size: { cols: 120, rows: 40 } },
    ready({ cols: 80, rows: 24, attached: 2 }),
  ]);
  const note = sizeNote(state);
  assert.match(note, /desk terminal/);
  assert.match(note, /80×24/, 'the note carries the size actually in force');
});

test('one shrunk dimension is enough to explain the screen', () => {
  const narrow = fold([
    { type: 'requested', size: { cols: 120, rows: 24 } },
    ready({ cols: 80, rows: 24, attached: 2 }),
  ]);
  assert.notEqual(sizeNote(narrow), null);
  const short = fold([
    { type: 'requested', size: { cols: 80, rows: 40 } },
    ready({ cols: 80, rows: 24, attached: 3 }),
  ]);
  assert.notEqual(sizeNote(short), null);
});

test('the note stays silent when there is nobody else to blame', () => {
  // Alone on the pty, a smaller size is the host's own floor — not another
  // person — and saying "the desk terminal" would be an invention.
  const alone = fold([
    { type: 'requested', size: { cols: 120, rows: 40 } },
    ready({ cols: 80, rows: 24, attached: 1 }),
  ]);
  assert.equal(sizeNote(alone), null);
});

test('the note stays silent when the phone got what it asked for', () => {
  const granted = fold([
    { type: 'requested', size: { cols: 80, rows: 24 } },
    ready({ cols: 80, rows: 24, attached: 2 }),
  ]);
  assert.equal(sizeNote(granted), null);
  const bigger = fold([
    { type: 'requested', size: { cols: 80, rows: 24 } },
    ready({ cols: 100, rows: 30, attached: 2 }),
  ]);
  assert.equal(sizeNote(bigger), null);
});

test('the note stays silent before the handshake and before a measurement', () => {
  assert.equal(sizeNote(INITIAL_ATTACH), null);
  const unmeasured = fold([ready({ cols: 40, rows: 10, attached: 3 })]);
  assert.equal(sizeNote(unmeasured), null);
});

test('a resize after ready can start explaining the screen', () => {
  const state = fold([
    { type: 'requested', size: { cols: 120, rows: 40 } },
    ready({ cols: 120, rows: 40, attached: 1 }),
  ]);
  assert.equal(sizeNote(state), null, 'alone and full size');
  const joined = fold([
    ready({ cols: 80, rows: 24, attached: 2 }),
    message({ type: 'resize', cols: 80, rows: 24 }),
  ], state);
  assert.match(sizeNote(joined), /80×24/);
});

test('a measurement is only news when it changes', () => {
  const measured = fold([{ type: 'requested', size: { cols: 100, rows: 30 } }]);
  assert.equal(reduceAttach(measured, { type: 'requested', size: { cols: 100, rows: 30 } }), measured);
});

// ---- who else is attached --------------------------------------------------

test('the attached count is reported as other people, not as a total', () => {
  assert.equal(othersAttached(1), null, 'one client is this one');
  assert.equal(othersAttached(2), '1 other attached');
  assert.equal(othersAttached(4), '3 others attached');
});

test('an absent or nonsense count says nothing rather than something wrong', () => {
  assert.equal(othersAttached(undefined), null);
  assert.equal(othersAttached(0), null);
  assert.equal(othersAttached(-3), null);
  assert.equal(othersAttached(Number.NaN), null);
});

test('nobody is claimed to be attached before the handshake lands', () => {
  assert.equal(attachedNote(INITIAL_ATTACH), null);
  assert.equal(attachedNote(fold([ready({ attached: 3 })])), '2 others attached');
});

test('the list\'s count wins over the handshake\'s, which never moves again', () => {
  // `ready` is a snapshot taken as this phone attached. Somebody joining a
  // minute later changes nothing on the socket, so the only way the phone can
  // ever say "someone else is looking at this" is the polled count.
  const alone = fold([ready({ attached: 1 })]);
  assert.equal(attachedNote(alone), null);
  assert.equal(attachedNote(alone, 2), '1 other attached');
  assert.equal(attachedNote(alone, 1), null, 'and it can say they left again');
});

test('a missing or nonsense polled count falls back to the handshake', () => {
  const two = fold([ready({ attached: 2 })]);
  assert.equal(effectiveAttached(two, undefined), 2);
  assert.equal(effectiveAttached(two, 0), 2);
  assert.equal(effectiveAttached(two, Number.NaN), 2);
  assert.equal(effectiveAttached(two, 5), 5);
});

test('a client that joined after the handshake also explains the smaller screen', () => {
  const state = fold([
    { type: 'requested', size: { cols: 120, rows: 40 } },
    ready({ cols: 120, rows: 40, attached: 1 }),
    message({ type: 'resize', cols: 40, rows: 12 }),
  ]);
  assert.equal(sizeNote(state), null, 'the socket still believes it is alone');
  assert.match(sizeNote(state, 2), /40×12/);
});

// ---- link states and reconnect ---------------------------------------------

test('a dropped socket re-attaches by itself; an exit and a refusal do not', () => {
  assert.equal(shouldReattach({ link: 'closed' }), true);
  assert.equal(shouldReattach({ link: 'exited' }), false, 'nothing left to replay');
  assert.equal(shouldReattach({ link: 'error' }), false, 'it would fail the same way');
  assert.equal(shouldReattach({ link: 'open' }), false);
  assert.equal(shouldReattach({ link: 'connecting' }), false);
});

test('the retry backoff lengthens and then holds, and is never out of range', () => {
  assert.equal(retryDelay(0), RETRY_DELAYS_MS[0]);
  for (let i = 1; i < RETRY_DELAYS_MS.length; i += 1) {
    assert.ok(retryDelay(i) > retryDelay(i - 1), `delay ${i} is longer than ${i - 1}`);
  }
  const last = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  assert.equal(retryDelay(99), last, 'hammering a host that is gone helps nobody');
  assert.equal(retryDelay(-5), RETRY_DELAYS_MS[0]);
});

test('a reopen counts against the backoff; pressing Reattach starts it over', () => {
  const dropped = fold([ready(), { type: 'link', link: 'closed' }]);
  const once = reduceAttach(dropped, { type: 'reopen' });
  assert.equal(once.link, 'connecting');
  assert.equal(once.ready, false, 'the size on screen is a guess again until the next ready');
  assert.equal(once.retries, 1);
  const twice = reduceAttach(once, { type: 'reopen' });
  assert.equal(twice.retries, 2);
  assert.equal(reduceAttach(twice, { type: 'reopen', manual: true }).retries, 0);
});

test('a successful handshake — not a socket that merely opened — clears the backoff', () => {
  const struggling = fold([
    { type: 'link', link: 'closed' }, { type: 'reopen' }, { type: 'reopen' },
  ]);
  assert.equal(struggling.retries, 2);
  assert.equal(reduceAttach(struggling, { type: 'link', link: 'open' }).retries, 2);
  assert.equal(reduceAttach(struggling, ready()).retries, 0);
});

test('a reconnect keeps the session identity so the header does not blink', () => {
  const back = fold([
    ready({ attached: 2 }),
    { type: 'link', link: 'closed' },
    { type: 'reopen' },
  ]);
  assert.deepEqual(back.session, { id: 's1', title: 'belay', cwd: '/p/belay' });
});

test('an ended session stays ended, whatever the socket does afterwards', () => {
  // The close that follows an exit is the consequence of it. Letting that
  // overwrite the state would turn "the session finished" into "reattaching…"
  // and then silently start a second claude.
  const ended = fold([ready(), message({ type: 'exit' }), { type: 'link', link: 'closed' }]);
  assert.equal(ended.link, 'exited');
  assert.equal(shouldReattach(ended), false);
  // Only a deliberate reopen moves it on.
  assert.equal(reduceAttach(ended, { type: 'link', link: 'connecting' }).link, 'connecting');
});

test('a refusal keeps its reason instead of decaying into "dropped"', () => {
  const refused = fold([
    message({ type: 'error', error: 'this session cannot be attached on this host' }),
    { type: 'link', link: 'closed' },
  ]);
  assert.equal(refused.link, 'error');
  assert.equal(refused.note, 'this session cannot be attached on this host');
});

test('a fresh ready clears a stale complaint', () => {
  const recovered = fold([
    message({ type: 'error', error: 'no such session' }),
    { type: 'reopen', manual: true },
    ready(),
  ]);
  assert.equal(recovered.note, '');
  assert.equal(recovered.link, 'open');
});

test('every link state has a word for the header — the screen is never blank about it', () => {
  const open = fold([ready()]);
  assert.equal(linkLabel(open), 'live');
  assert.equal(linkLabel({ ...open, ready: false }), 'attaching');
  assert.equal(linkLabel(INITIAL_ATTACH), 'attaching');
  assert.equal(linkLabel({ ...INITIAL_ATTACH, retries: 2 }), 'reattaching');
  assert.equal(linkLabel({ ...INITIAL_ATTACH, link: 'closed' }), 'reattaching');
  assert.equal(linkLabel({ ...INITIAL_ATTACH, link: 'exited' }), 'ended');
  assert.equal(linkLabel({ ...INITIAL_ATTACH, link: 'error' }), 'failed');
});
