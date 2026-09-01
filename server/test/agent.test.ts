// Unit tests for the pure parts of the agent module: turning claude's
// stream-json output into phone events, and summarizing tool inputs.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalTimeoutMs, buildClaudeArgs, parseClaudeLine, toolDetail } from '../src/agent.js';

test('toolDetail picks the meaningful field per tool', () => {
  assert.equal(toolDetail('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(toolDetail('Edit', { file_path: 'C:/x/y.ts', old_string: 'a', new_string: 'b' }), 'C:/x/y.ts');
  assert.equal(toolDetail('Grep', { pattern: 'foo.*bar' }), 'foo.*bar');
  assert.equal(toolDetail('SomethingNew', { whatever: 'hello', n: 3 }), 'hello');
  assert.equal(toolDetail('Bash', null), '');
});

test('toolDetail truncates long values', () => {
  const long = 'x'.repeat(500);
  const d = toolDetail('Bash', { command: long });
  assert.ok(d.length <= 301);
  assert.ok(d.endsWith('…'));
});

test('parseClaudeLine extracts the session id from init', () => {
  const { events, sessionId } = parseClaudeLine(JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'abc-123', model: 'claude',
  }));
  assert.equal(sessionId, 'abc-123');
  assert.equal(events.length, 0);
});

test('parseClaudeLine maps assistant text and tool_use blocks', () => {
  const { events } = parseClaudeLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the file now.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
        { type: 'text', text: '   ' }, // whitespace-only text is dropped
      ],
    },
  }));
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['text', 'tool'],
  );
  assert.equal(events[0].text, 'Looking at the file now.');
  assert.equal(events[1].tool, 'Read');
  assert.equal(events[1].detail, 'src/a.ts');
});

test('parseClaudeLine maps results and flags the turn done', () => {
  const ok = parseClaudeLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, duration_ms: 4200,
  }));
  assert.equal(ok.done, true);
  assert.equal(ok.events[0].kind, 'result');
  assert.equal(ok.events[0].ok, true);
  assert.equal(ok.events[0].costUsd, 0.12);

  const bad = parseClaudeLine(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom',
  }));
  assert.equal(bad.events[0].ok, false);
  assert.equal(bad.events[0].text, 'boom');
});

test('buildClaudeArgs adds --resume only for attached/revived sessions', () => {
  const fresh = buildClaudeArgs('C:\\tmp\\mcp.json');
  assert.ok(!fresh.includes('--resume'));
  assert.ok(fresh.includes('--permission-prompt-tool'));
  assert.equal(fresh[fresh.indexOf('--mcp-config') + 1], 'C:\\tmp\\mcp.json');

  const resumed = buildClaudeArgs('C:\\tmp\\mcp.json', 'abc-123');
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'abc-123');
  // the approval tool must survive the resume path — that's the safety net
  assert.ok(resumed.includes('mcp__belay-approve__request_permission'));
});

test('parseClaudeLine ignores noise and malformed lines', () => {
  assert.equal(parseClaudeLine('not json at all').events.length, 0);
  assert.equal(parseClaudeLine(JSON.stringify({ type: 'user', message: {} })).events.length, 0);
  assert.equal(parseClaudeLine(JSON.stringify({ type: 'stream_event' })).events.length, 0);
});

test('approvalTimeoutMs: unset and garbage fall back to the 30-minute default', () => {
  const DEFAULT = 30 * 60 * 1000;
  assert.equal(approvalTimeoutMs(undefined), DEFAULT);
  assert.equal(approvalTimeoutMs(''), DEFAULT);
  assert.equal(approvalTimeoutMs('  '), DEFAULT);
  assert.equal(approvalTimeoutMs('soon'), DEFAULT);
  assert.equal(approvalTimeoutMs('-1'), DEFAULT);
  assert.equal(approvalTimeoutMs('NaN'), DEFAULT);
});

test('approvalTimeoutMs: zero means wait forever, positives are floored at a minute', () => {
  assert.equal(approvalTimeoutMs('0'), 0);
  // A sub-minute window recreates the silent-auto-deny bug with a sharper
  // edge, so it is rounded up rather than honoured.
  assert.equal(approvalTimeoutMs('500'), 60_000);
  assert.equal(approvalTimeoutMs('60000'), 60_000);
  assert.equal(approvalTimeoutMs('900000'), 900_000);
});
