// Tests for the shared, refcounted transcript follower under /ws/transcript:
// growth reaches every reader, partial lines are held, and the last reader
// closes the watcher. The 2-second poll backs fs.watch, so the waits below
// are generous only where the poll is the mechanism that must fire.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tailTranscript, tailedFileCount } from '../src/transcript-tail.js';
import { readTranscriptWindow } from '../src/transcript.js';

const line = (o: object) => JSON.stringify(o) + '\n';
const user = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });

// fs.watch arms a beat after it is created; a write in the same tick can
// slip past it and be caught by the poll instead. Real transcripts never
// race their own watcher, so the tests give it that beat.
const settle = () => new Promise((r) => setTimeout(r, 50));

function waitFor(pred: () => boolean, ms = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('tailTranscript delivers appended lines to every reader and shares one watcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tailws-'));
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, user('one'));
    const start = readTranscriptWindow(file).offset;

    let aGrew = 0; let bGrew = 0;
    const a = tailTranscript(file, start, () => { aGrew++; });
    const b = tailTranscript(file, start, () => { bGrew++; });
    assert.equal(tailedFileCount(), 1);
    await settle();

    appendFileSync(file, user('two'));
    await waitFor(() => aGrew > 0 && bGrew > 0);

    const wa = a.next();
    assert.deepEqual(wa.events.map((e) => e.text), ['two']);
    const wb = b.next();
    assert.deepEqual(wb.events.map((e) => e.text), ['two']);
    // Each reader advanced independently: nothing left for either.
    assert.deepEqual(a.next().events, []);

    a.close();
    assert.equal(tailedFileCount(), 1);
    b.close();
    assert.equal(tailedFileCount(), 0);
    b.close(); // idempotent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tailTranscript holds a torn line until its newline arrives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tailws-'));
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, user('one'));
    const start = readTranscriptWindow(file).offset;
    let grew = 0;
    const r = tailTranscript(file, start, () => { grew++; });
    await settle();

    appendFileSync(file, '{"type":"user","message":{"role":"user","content":"tw');
    await waitFor(() => grew > 0);
    assert.deepEqual(r.next().events, []);

    const seen = grew;
    appendFileSync(file, 'o"}}\n');
    await waitFor(() => grew > seen);
    assert.deepEqual(r.next().events.map((e) => e.text), ['two']);
    r.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a closed reader returns nothing and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tailws-'));
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, user('one'));
    const r = tailTranscript(file, 0, () => {});
    r.close();
    assert.deepEqual(r.next().events, []);
    assert.equal(tailedFileCount(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
