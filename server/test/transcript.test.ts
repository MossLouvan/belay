// Tests for the resume-history loader: real Claude Code transcript shapes,
// the bounded tail read, and the ways a transcript can be absent or damaged.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HISTORY_CAP, TAIL_BYTES, loadClaudeHistory, readTail, readTranscriptWindow, transcriptEvents } from '../src/transcript.js';

const line = (o: object) => JSON.stringify(o);

// Entry shapes below mirror real files under ~/.claude/projects: user entries
// carry either a plain-string prompt or tool_result blocks; assistant entries
// wrap an API message; bookkeeping types interleave freely.
const SAMPLE = [
  line({ type: 'summary', summary: 'Fixing the build', leafUuid: 'x' }),
  line({ type: 'user', isSidechain: false, timestamp: '2026-08-30T10:00:00.000Z', cwd: '/tmp/p', message: { role: 'user', content: 'fix the failing test' } }),
  line({ type: 'assistant', isSidechain: false, timestamp: '2026-08-30T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } }),
  line({ type: 'user', isSidechain: false, timestamp: '2026-08-30T10:00:09.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Exit code 1\n1 failing', is_error: true }] } }),
  line({ type: 'user', isSidechain: true, timestamp: '2026-08-30T10:00:10.000Z', message: { role: 'user', content: 'subagent chatter' } }),
  line({ type: 'queue-operation', operation: 'enqueue' }),
  line({ type: 'user', isSidechain: false, timestamp: '2026-08-30T10:00:11.000Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  '{"type":"assistant","message":{"content":[{"ty', // torn line, as a crash would leave
];

test('transcriptEvents keeps the conversation and skips the bookkeeping', () => {
  const events = transcriptEvents(SAMPLE);
  assert.deepEqual(events.map((e) => e.kind), ['user', 'text', 'tool', 'tool-result']);
  assert.equal(events[0].text, 'fix the failing test');
  assert.equal(events[0].t, Date.parse('2026-08-30T10:00:00.000Z'));
  assert.equal(events[2].callId, 'toolu_1');
  assert.equal(events[3].ok, false);
  assert.match(events[3].text!, /1 failing/);
});

test('transcriptEvents caps to the most recent events', () => {
  const many = Array.from({ length: 300 }, (_, i) =>
    line({ type: 'user', timestamp: '2026-08-30T10:00:00.000Z', message: { role: 'user', content: `prompt ${i}` } }));
  const events = transcriptEvents(many);
  assert.equal(events.length, HISTORY_CAP);
  assert.equal(events[events.length - 1].text, 'prompt 299');
});

test('readTail is bounded and drops the torn first line of a mid-file read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tail-'));
  try {
    const file = join(dir, 'big.jsonl');
    const rows = Array.from({ length: 5000 }, (_, i) => line({ type: 'user', message: { content: `row ${i}` } }));
    writeFileSync(file, rows.join('\n') + '\n', 'utf8');
    const tail = readTail(file);
    assert.ok(Buffer.byteLength(tail) <= TAIL_BYTES);
    // Every surviving line parses: the fragment where the read landed is gone.
    for (const l of tail.split('\n').filter(Boolean)) JSON.parse(l);
    assert.match(tail, /row 4999/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadClaudeHistory finds the transcript by scanning project dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'belay-hist-'));
  try {
    const projDir = join(root, '-tmp-p');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'aaaa-bbbb.jsonl'), SAMPLE.join('\n') + '\n', 'utf8');
    const events = loadClaudeHistory('aaaa-bbbb', root);
    assert.equal(events.length, 4);
    assert.equal(events[0].kind, 'user');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing or corrupt transcript yields [], never a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'belay-hist-'));
  try {
    assert.deepEqual(loadClaudeHistory('nope', root), []);
    assert.deepEqual(loadClaudeHistory('nope', join(root, 'not-a-root')), []);
    const projDir = join(root, '-tmp-q');
    mkdirSync(projDir);
    // A file of binary garbage: nothing parses, nothing explodes.
    writeFileSync(join(projDir, 'cccc-dddd.jsonl'), Buffer.from([0, 1, 2, 255, 10, 254, 253]));
    assert.deepEqual(loadClaudeHistory('cccc-dddd', root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- readTranscriptWindow ---------------------------------------------------

test('readTranscriptWindow without `after` returns the tail and where it ended', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-win-'));
  try {
    const file = join(dir, 's.jsonl');
    const body = SAMPLE.slice(0, -1).join('\n') + '\n';
    writeFileSync(file, body, 'utf8');
    const win = readTranscriptWindow(file);
    assert.deepEqual(win.events.map((e) => e.kind), ['user', 'text', 'tool', 'tool-result']);
    assert.equal(win.offset, Buffer.byteLength(body));
    assert.equal(win.size, Buffer.byteLength(body));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTranscriptWindow with `after` returns only what came later, and holds a partial line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-win-'));
  try {
    const file = join(dir, 's.jsonl');
    const first = line({ type: 'user', message: { role: 'user', content: 'one' } }) + '\n';
    writeFileSync(file, first, 'utf8');
    const w1 = readTranscriptWindow(file);
    assert.equal(w1.events.length, 1);

    // Nothing new yet.
    const w2 = readTranscriptWindow(file, w1.offset);
    assert.deepEqual(w2.events, []);
    assert.equal(w2.offset, w1.offset);

    // A second line lands, then a third is torn mid-write.
    const second = line({ type: 'user', message: { role: 'user', content: 'two' } }) + '\n';
    writeFileSync(file, first + second + '{"type":"user","mess', 'utf8');
    const w3 = readTranscriptWindow(file, w1.offset);
    assert.deepEqual(w3.events.map((e) => e.text), ['two']);
    assert.equal(w3.offset, Buffer.byteLength(first + second));

    // The newline arrives; the held fragment is read whole.
    const third = line({ type: 'user', message: { role: 'user', content: 'three' } }) + '\n';
    writeFileSync(file, first + second + third, 'utf8');
    const w4 = readTranscriptWindow(file, w3.offset);
    assert.deepEqual(w4.events.map((e) => e.text), ['three']);
    assert.equal(w4.offset, Buffer.byteLength(first + second + third));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTranscriptWindow tolerates an offset past the end (file truncated) by starting over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-win-'));
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, line({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n', 'utf8');
    const win = readTranscriptWindow(file, 10_000);
    assert.equal(win.events.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTranscriptWindow on a big file is bounded and skips the torn first line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-win-'));
  try {
    const file = join(dir, 'big.jsonl');
    const rows = Array.from({ length: 5000 }, (_, i) => line({ type: 'user', message: { content: `row ${i}` } }));
    const body = rows.join('\n') + '\n';
    writeFileSync(file, body, 'utf8');
    const win = readTranscriptWindow(file, undefined, HISTORY_CAP);
    assert.equal(win.events.length, HISTORY_CAP);
    assert.equal(win.events[win.events.length - 1].text, 'row 4999');
    assert.equal(win.offset, Buffer.byteLength(body));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
