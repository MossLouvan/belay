// Unit tests for session discovery: JSONL head parsing, mtime ordering, the
// scan cap, and exclusion of already-attached ids. Fixtures are synthetic
// transcripts in a temp dir — no real ~/.claude is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMeta, scanSessions } from '../src/discover.js';

function line(obj: object): string { return JSON.stringify(obj) + '\n'; }

test('extractMeta reads cwd and first user prompt (string content)', () => {
  const head =
    'garbage not json\n' +
    line({ type: 'summary', summary: 'x' }) +
    line({ type: 'user', cwd: 'C:\\proj', message: { role: 'user', content: '  fix the   login bug  ' } });
  const meta = extractMeta(head);
  assert.equal(meta.cwd, 'C:\\proj');
  assert.equal(meta.preview, 'fix the login bug');
});

test('extractMeta handles content-block arrays and separate cwd lines', () => {
  const head =
    line({ type: 'system', cwd: '/home/x/proj' }) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'noise' }, { type: 'text', text: 'add dark mode' }] } });
  const meta = extractMeta(head);
  assert.equal(meta.cwd, '/home/x/proj');
  assert.equal(meta.preview, 'add dark mode');
});

test('extractMeta trims previews to 120 chars and survives no matches', () => {
  const long = 'w'.repeat(300);
  const meta = extractMeta(line({ type: 'user', cwd: 'x', message: { content: long } }));
  assert.equal(meta.preview!.length, 120);
  assert.deepEqual(extractMeta('nothing\nparseable\n'), { cwd: undefined, preview: undefined });
});

function makeFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'deskhandler-discover-'));
  const projects = join(root, 'projects');
  const proj = join(projects, 'C--fake-proj');
  mkdirSync(proj, { recursive: true });
  const cwd = root; // a real, existing folder for sessions to point at

  const write = (name: string, content: string, ageMin: number) => {
    const file = join(proj, name);
    writeFileSync(file, content, 'utf8');
    const t = new Date(Date.now() - ageMin * 60000);
    utimesSync(file, t, t);
  };

  write('aaa.jsonl', line({ type: 'user', cwd, message: { content: 'newest session' } }), 1);
  write('bbb.jsonl', line({ type: 'user', cwd, message: { content: 'middle session' } }), 10);
  write('ccc.jsonl', line({ type: 'user', cwd, message: { content: 'oldest session' } }), 60);
  // no cwd recoverable → skipped
  write('ddd.jsonl', line({ type: 'user', message: { content: 'homeless' } }), 2);
  // cwd no longer exists → skipped
  write('eee.jsonl', line({ type: 'user', cwd: join(root, 'gone'), message: { content: 'orphan' } }), 3);
  // not a transcript → ignored
  writeFileSync(join(proj, 'notes.txt'), 'hi', 'utf8');

  return { projects, cwd };
}

test('scanSessions orders by mtime, skips bad cwds, keeps previews', () => {
  const { projects, cwd } = makeFixtures();
  const found = scanSessions(projects, new Set());
  assert.deepEqual(found.map((s) => s.claudeSessionId), ['aaa', 'bbb', 'ccc']);
  assert.equal(found[0].preview, 'newest session');
  assert.ok(found.every((s) => s.cwd === cwd));
});

test('scanSessions applies exclusion before the cap', () => {
  const { projects } = makeFixtures();
  const excluded = scanSessions(projects, new Set(['aaa']));
  assert.deepEqual(excluded.map((s) => s.claudeSessionId), ['bbb', 'ccc']);
  // cap of 1 with the newest excluded still yields the next-newest
  const capped = scanSessions(projects, new Set(['aaa']), 1);
  assert.deepEqual(capped.map((s) => s.claudeSessionId), ['bbb']);
});

test('scanSessions returns [] for a missing root', () => {
  assert.deepEqual(scanSessions(join(tmpdir(), 'deskhandler-no-such-root'), new Set()), []);
});
