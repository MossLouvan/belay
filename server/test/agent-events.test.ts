// Unit tests for the tool-result half of the stream-json translation: the
// events the feed used to drop. Shapes here are copied from real Claude Code
// output — a tool result is a *user* message whose content carries
// tool_result blocks, with content as either a plain string or text blocks.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_CAP, eventsFromToolResults, parseClaudeLine } from '../src/agent-events.js';

test('parseClaudeLine surfaces a string tool result, paired to its call', () => {
  const { events } = parseClaudeLine(JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01abc', content: 'PASS  4 tests' }],
    },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool-result');
  assert.equal(events[0].ok, true);
  assert.equal(events[0].text, 'PASS  4 tests');
  assert.equal(events[0].chars, 13);
  assert.equal(events[0].callId, 'toolu_01abc');
});

test('block-shaped result content is joined; non-text blocks are skipped', () => {
  const events = eventsFromToolResults([
    {
      type: 'tool_result', tool_use_id: 'toolu_02',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image', source: { data: 'zzz' } },
        { type: 'text', text: 'line two' },
      ],
    },
  ], 5);
  assert.equal(events[0].text, 'line one\nline two');
  assert.equal(events[0].t, 5);
});

test('a failed result is marked failed, exactly like real CLI output', () => {
  // Verbatim shape from a real transcript: is_error rides on the block.
  const { events } = parseClaudeLine(JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: 'Exit code 1\nnpm ERR! test failed', is_error: true }],
    },
  }));
  assert.equal(events[0].ok, false);
  assert.match(events[0].text!, /Exit code 1/);
});

test('long output is truncated to the cap but reports its full length', () => {
  const big = 'x'.repeat(50_000);
  const events = eventsFromToolResults([{ type: 'tool_result', tool_use_id: 't', content: big }], 0);
  assert.equal(events[0].text!.length, RESULT_CAP + 1); // cap plus the ellipsis
  assert.ok(events[0].text!.endsWith('…'));
  assert.equal(events[0].chars, 50_000);
});

test('an empty result is still an event — "ran and printed nothing" is an answer', () => {
  const events = eventsFromToolResults([{ type: 'tool_result', tool_use_id: 't', content: '' }], 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '');
  assert.equal(events[0].chars, 0);
});

test('tool_use events now carry the call id their result will pair with', () => {
  const { events } = parseClaudeLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_04', name: 'Bash', input: { command: 'npm test' } }] },
  }));
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].callId, 'toolu_04');
});

test('user messages without tool results still map to nothing', () => {
  // The user's own prompt goes in on stdin and is pushed to the feed by
  // sendPrompt — surfacing it here would duplicate every prompt.
  assert.equal(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })).events.length, 0);
  assert.equal(parseClaudeLine(JSON.stringify({ type: 'user', message: {} })).events.length, 0);
});
