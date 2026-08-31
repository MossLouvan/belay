// Unit tests for the feed-shaping model: pairing tool results to their calls
// and the words on the expand toggle.
//
//   cd app && node --test src/agent/feed-model.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions. Only
// JSX-free modules are imported, since Node strips types but does not compile
// JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFeed, resultLines, resultToggleLabel, resultTruncated, truncationNote } from './feed-model.ts';
import { parseEvent } from './model.ts';

const tool = (callId, detail = 'npm test') => ({ t: 1, kind: 'tool', tool: 'Bash', detail, callId });
const result = (callId, extra = {}) => ({ t: 2, kind: 'tool-result', ok: true, text: 'PASS', chars: 4, callId, ...extra });

// ---- pairing ----------------------------------------------------------------

test('a result folds onto the call that produced it', () => {
  const feed = buildFeed([{ t: 0, kind: 'text', text: 'Running tests.' }, tool('a'), result('a')]);
  assert.equal(feed.length, 2);
  assert.equal(feed[1].event.kind, 'tool');
  assert.equal(feed[1].result.callId, 'a');
});

test('parallel calls pair by id, not by order', () => {
  const feed = buildFeed([tool('a', 'one'), tool('b', 'two'), result('b'), result('a', { text: 'FAIL', ok: false })]);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].result.callId, 'a');
  assert.equal(feed[0].result.ok, false);
  assert.equal(feed[1].result.callId, 'b');
});

test('an orphan result stands alone instead of vanishing', () => {
  // Its call fell off the 400-event cap, or the tool event predates callId.
  const feed = buildFeed([result('ghost'), { t: 3, kind: 'tool', tool: 'Read' }, result('also-ghost')]);
  assert.equal(feed.length, 3);
  assert.equal(feed[0].event.kind, 'tool-result');
  assert.equal(feed[2].event.kind, 'tool-result');
  assert.equal(feed[1].result, undefined);
});

test('a second result for the same call does not overwrite the first', () => {
  const feed = buildFeed([tool('a'), result('a'), result('a', { text: 'dupe' })]);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].result.text, 'PASS');
  assert.equal(feed[1].event.text, 'dupe');
});

test('buildFeed never mutates its input', () => {
  const events = [tool('a'), result('a')];
  const copy = structuredClone(events);
  buildFeed(events);
  assert.deepEqual(events, copy);
});

// ---- toggle words -----------------------------------------------------------

test('the toggle names failure before anyone taps', () => {
  const ok = result('a', { text: 'one\ntwo\nthree' });
  assert.equal(resultToggleLabel(ok, false), '▸ output · 3 lines');
  assert.equal(resultToggleLabel(ok, true), '▾ output · 3 lines');
  const bad = result('a', { ok: false, text: 'Exit code 1' });
  assert.equal(resultToggleLabel(bad, false), '▸ ✗ failed · 1 line');
});

test('truncation is reported honestly, and only when it happened', () => {
  const cut = result('a', { text: 'x'.repeat(2000) + '…', chars: 50_000 });
  assert.equal(resultTruncated(cut), true);
  assert.equal(truncationNote(cut), 'showing first 2.0 KB of 48.8 KB');
  assert.equal(resultTruncated(result('a')), false);
  assert.equal(resultLines(result('a', { text: '' })), 0);
});

// ---- wire acceptance --------------------------------------------------------

test('parseEvent accepts the host\'s tool-result shape and keeps the pairing fields', () => {
  const ev = parseEvent({ t: 9, kind: 'tool-result', ok: false, text: 'boom', chars: 4, callId: 'toolu_1' });
  assert.equal(ev.kind, 'tool-result');
  assert.equal(ev.ok, false);
  assert.equal(ev.callId, 'toolu_1');
  assert.equal(ev.chars, 4);
  // Junk in the new fields is dropped, not rendered.
  const junk = parseEvent({ t: 9, kind: 'tool-result', callId: 42, chars: 'big' });
  assert.equal(junk.callId, undefined);
  assert.equal(junk.chars, undefined);
});
