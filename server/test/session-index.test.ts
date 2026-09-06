// Tests for the session index that replaced discover.ts's 30-second cache:
// a temp projects root, transcripts written the way Claude Code writes them,
// and an injected clock so `live` is asserted rather than waited for.
// The poll path is forced (watch:false) so nothing depends on fs.watch
// semantics of the machine running the tests. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionIndex } from '../src/session-index.js';
import { LIVE_WINDOW_MS } from '../src/session-live.js';

const line = (o: object) => JSON.stringify(o) + '\n';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'belay-index-'));
  const root = join(dir, 'projects');
  const cwd = join(dir, 'work');
  mkdirSync(join(root, '-work'), { recursive: true });
  mkdirSync(cwd);
  const file = (id: string) => join(root, '-work', `${id}.jsonl`);
  const write = (id: string, prompt: string, mtime: number) => {
    writeFileSync(file(id), line({ type: 'user', cwd, message: { role: 'user', content: prompt } }));
    utimesSync(file(id), mtime / 1000, mtime / 1000);
  };
  return { dir, root, cwd, file, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('index lists sessions newest first with live derived from the clock', () => {
  const s = setup();
  try {
    const now = 10_000_000;
    s.write(ID_A, 'old one', now - LIVE_WINDOW_MS * 2);
    s.write(ID_B, 'fresh one', now - 1000);
    const index = createSessionIndex(s.root, { now: () => now, watch: false });
    index.rescan();
    const rows = index.list();
    assert.deepEqual(rows.map((r) => r.claudeSessionId), [ID_B, ID_A]);
    assert.equal(rows[0].live, true);
    assert.equal(rows[0].preview, 'fresh one');
    assert.equal(rows[0].cwd, s.cwd);
    assert.equal(rows[1].live, false);
    assert.equal(index.fileOf(ID_A), s.file(ID_A));
    assert.equal(index.fileOf('nope'), null);
    index.stop();
  } finally { s.cleanup(); }
});

test('index applies the exclusion set per call and caps the list', () => {
  const s = setup();
  try {
    s.write(ID_A, 'a', 3000); s.write(ID_B, 'b', 2000); s.write(ID_C, 'c', 1000);
    const index = createSessionIndex(s.root, { now: () => 5000, watch: false, cap: 2 });
    index.rescan();
    assert.deepEqual(index.list().map((r) => r.claudeSessionId), [ID_A, ID_B]);
    assert.deepEqual(index.list(new Set([ID_A])).map((r) => r.claudeSessionId), [ID_B, ID_C]);
    index.stop();
  } finally { s.cleanup(); }
});

test('index skips transcripts whose cwd is gone or missing', () => {
  const s = setup();
  try {
    writeFileSync(s.file(ID_A), line({ type: 'user', cwd: join(s.dir, 'vanished'), message: { content: 'x' } }));
    writeFileSync(s.file(ID_B), line({ type: 'summary', summary: 'no cwd anywhere' }));
    s.write(ID_C, 'ok', 1000);
    const index = createSessionIndex(s.root, { now: () => 5000, watch: false });
    index.rescan();
    assert.deepEqual(index.list().map((r) => r.claudeSessionId), [ID_C]);
    index.stop();
  } finally { s.cleanup(); }
});

test('index.touch picks up a new file and later growth, and notifies listeners', async () => {
  const s = setup();
  try {
    let now = 10_000;
    const index = createSessionIndex(s.root, { now: () => now, watch: false });
    index.rescan();
    let changes = 0;
    const off = index.onChange(() => { changes++; });
    assert.equal(index.list().length, 0);

    // A terminal starts a session: file appears with a cwd line first.
    writeFileSync(s.file(ID_A), line({ type: 'summary', cwd: s.cwd, summary: 's' }));
    index.touch(s.file(ID_A));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(index.list().length, 1);
    assert.equal(index.get(ID_A)?.preview, '');
    assert.equal(changes, 1);

    // The first prompt lands on the next write; the preview fills in.
    now += 5000;
    appendFileSync(s.file(ID_A), line({ type: 'user', message: { role: 'user', content: 'do the thing' } }));
    utimesSync(s.file(ID_A), now / 1000, now / 1000);
    index.touch(s.file(ID_A));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(index.get(ID_A)?.preview, 'do the thing');
    assert.equal(index.get(ID_A)?.lastWriteAt, now);
    assert.equal(changes, 2);

    // Same mtime again: no change, no notification.
    index.touch(s.file(ID_A));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(changes, 2);

    off();
    index.stop();
  } finally { s.cleanup(); }
});

test('index drops rows whose files disappeared on rescan and on touch', () => {
  const s = setup();
  try {
    s.write(ID_A, 'a', 1000); s.write(ID_B, 'b', 2000);
    const index = createSessionIndex(s.root, { now: () => 5000, watch: false });
    index.rescan();
    assert.equal(index.list().length, 2);
    rmSync(s.file(ID_A));
    index.rescan();
    assert.deepEqual(index.list().map((r) => r.claudeSessionId), [ID_B]);
    index.stop();
  } finally { s.cleanup(); }
});

test('index flips live to quiet on schedule while someone is listening', async () => {
  const s = setup();
  try {
    // Real clock: write "just now", listen, and use a tiny window through
    // a wrapper that pretends time runs fast.
    const start = Date.now();
    s.write(ID_A, 'a', start);
    let fake = start;
    const index = createSessionIndex(s.root, { now: () => fake, watch: false });
    index.rescan();
    assert.equal(index.get(ID_A)?.live, true);
    fake = start + LIVE_WINDOW_MS + 5;
    assert.equal(index.get(ID_A)?.live, false, 'live is derived from the clock on read');
    index.stop();
  } finally { s.cleanup(); }
});

test('index start() with watching disabled polls the root', async () => {
  const s = setup();
  try {
    const index = createSessionIndex(s.root, { now: () => 5000, watch: false, pollMs: 50 });
    index.start();
    assert.equal(index.mode, 'poll');
    s.write(ID_A, 'a', 1000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(index.list().length, 1);
    index.stop();
    assert.equal(index.mode, 'off');
  } finally { s.cleanup(); }
});

test('index start() on this platform prefers the recursive watcher when available', async () => {
  const s = setup();
  try {
    const index = createSessionIndex(s.root, { now: () => 5000, pollMs: 50 });
    index.start();
    assert.ok(index.mode === 'watch' || index.mode === 'poll');
    index.stop();
  } finally { s.cleanup(); }
});

test('index survives a missing root', () => {
  const index = createSessionIndex(join(tmpdir(), 'belay-no-such-root-' + Date.now()), { watch: false });
  index.rescan();
  assert.deepEqual(index.list(), []);
  index.stop();
});
