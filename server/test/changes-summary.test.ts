// The summary's wording is the feature: a phone-sized answer to "did Claude
// do roughly what I asked, and is anything alarming?". These tests lead with
// the destructive cases, because that is where a soothing summary would do
// real harm — a deleted test suite must never read as a tidy-up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeChanges } from '../src/changes-summary.js';
import type { ChangedFile } from '../src/changes-summary.js';

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, kind: 'edited', added: 10, removed: 2, binary: false, ...over,
});

/** Every word the owner reads must survive this: no git-speak, ever. */
function assertNoJargon(text: string): void {
  for (const banned of [
    /insertion/i, /deletion\b/i, /\bdiff\b/i, /\bcommit\b/i, /\bHEAD\b/,
    /working tree/i, /\brepo(sitory)?\b/i, /\bstaged?\b/i, /\d+\s*\(\+\)/, /\(\-\)/,
  ]) {
    assert.ok(!banned.test(text), `jargon ${banned} in: ${text}`);
  }
}

// ---- destructive cases first ----------------------------------------------

test('a deleted file is a caution, named, before anything reassuring', () => {
  const s = summarizeChanges([
    file('src/app.ts'),
    file('src/legacy-auth.ts', { kind: 'deleted', added: 0, removed: 180 }),
  ]);
  assert.ok(s.cautions.length >= 1);
  assert.match(s.cautions[0]!, /deleted/i);
  assert.match(s.cautions[0]!, /legacy-auth\.ts/);
  assert.match(s.cautions[0]!, /meant to happen/i);
  // The headline's verb order also puts the deletion first.
  assert.match(s.headline, /deleted 1 file and edited 1 file/i);
  assertNoJargon([s.headline, ...s.cautions].join(' '));
});

test('several deleted files are counted and listed, not glossed', () => {
  const s = summarizeChanges([
    file('a.ts', { kind: 'deleted' }),
    file('b.ts', { kind: 'deleted' }),
    file('c.ts', { kind: 'deleted' }),
    file('d.ts', { kind: 'deleted' }),
    file('e.ts', { kind: 'deleted' }),
  ]);
  assert.match(s.cautions[0]!, /deleted 5 files/i);
  assert.match(s.cautions[0]!, /a\.ts, b\.ts, c\.ts and 2 others/);
});

test('deleted tests get their own caution explaining why it matters', () => {
  const s = summarizeChanges([
    file('server/test/auth.test.ts', { kind: 'deleted', added: 0, removed: 240 }),
  ]);
  const testCaution = s.cautions.find((c) => /tests were removed/i.test(c));
  assert.ok(testCaution, s.cautions.join(' | '));
  assert.match(testCaution!, /auth\.test\.ts/);
  assert.match(testCaution!, /less is being checked/i);
  // "tidied up" style softening must never appear.
  assert.ok(!/tid(y|ied)|clean(ed)? up/i.test([s.headline, ...s.cautions].join(' ')));
});

test('a test file that shrank a lot is flagged even without being deleted', () => {
  const s = summarizeChanges([
    file('app/src/agent/agent.test.mjs', { added: 4, removed: 120 }),
  ]);
  const testCaution = s.cautions.find((c) => /tests were removed/i.test(c));
  assert.ok(testCaution);
  assert.match(testCaution!, /120 lines/);
});

test('a large lopsided removal from an ordinary file is called out with numbers', () => {
  const s = summarizeChanges([
    file('src/engine.ts', { added: 12, removed: 340 }),
    file('src/other.ts', { added: 5, removed: 1 }),
  ]);
  const caution = s.cautions.find((c) => /engine\.ts/.test(c));
  assert.ok(caution, s.cautions.join(' | '));
  assert.match(caution!, /340 lines gone/);
});

test('a balanced refactor is NOT flagged as a heavy removal', () => {
  const s = summarizeChanges([file('src/engine.ts', { added: 300, removed: 280 })]);
  assert.equal(s.cautions.length, 0);
});

test('touching a secrets file is a caution even when the change is tiny', () => {
  const s = summarizeChanges([file('.env', { added: 1, removed: 1 })]);
  assert.match(s.cautions[0]!, /\.env/);
  assert.match(s.cautions[0]!, /passwords or keys/i);
});

test('build/run configuration changes are pointed out', () => {
  const s = summarizeChanges([
    file('package.json', { added: 2, removed: 0 }),
    file('.github/workflows/ci.yml', { added: 8, removed: 3 }),
  ]);
  const caution = s.cautions.find((c) => /built or run/i.test(c));
  assert.ok(caution);
  assert.match(caution!, /package\.json/);
});

test('caution order: deletion outranks secrets outranks config', () => {
  const s = summarizeChanges([
    file('package.json'),
    file('.env.local', { added: 1, removed: 0 }),
    file('old.ts', { kind: 'deleted' }),
  ]);
  assert.match(s.cautions[0]!, /deleted/i);
  assert.match(s.cautions[1]!, /passwords or keys/i);
  assert.match(s.cautions[2]!, /built or run/i);
});

// ---- the headline ----------------------------------------------------------

test('no changes reads as exactly that', () => {
  const s = summarizeChanges([]);
  assert.equal(s.headline, 'No changes — every file is exactly as it was before.');
  assert.equal(s.cautions.length, 0);
});

test('a single edited file is named, not counted', () => {
  const s = summarizeChanges([file('server/src/index.ts', { added: 14, removed: 3 })]);
  assert.match(s.headline, /^Claude edited one file, server\/src\/index\.ts\./);
  assert.match(s.headline, /14 new lines/);
  assertNoJargon(s.headline);
});

test('a typical multi-file change reads as one plain sentence with a place', () => {
  const s = summarizeChanges([
    file('app/login/form.tsx', { added: 60, removed: 8 }),
    file('app/login/validate.ts', { added: 42, removed: 2 }),
    file('app/login/copy.ts', { kind: 'new', added: 18, removed: 0 }),
  ]);
  assert.match(s.headline, /Claude edited 2 files and added 1 new file — all in the app folder\./);
  assert.match(s.headline, /Mostly new work: about 120 new lines, with 10 removed\./);
  assert.equal(s.cautions.length, 0);
  assertNoJargon(s.headline);
});

test('"mostly in" appears when most but not all files share a folder', () => {
  const s = summarizeChanges([
    file('server/a.ts'), file('server/b.ts'), file('app/c.ts'),
  ]);
  assert.match(s.headline, /mostly in the server folder/);
});

test('no location is claimed when the change is scattered', () => {
  const s = summarizeChanges([file('a/x.ts'), file('b/y.ts'), file('c/z.ts')]);
  assert.ok(!/folder/.test(s.headline), s.headline);
});

test('a tiny change says so instead of quoting numbers', () => {
  const s = summarizeChanges([file('src/a.ts', { added: 3, removed: 1 })]);
  assert.match(s.headline, /Only a few lines changed\./);
});

test('pure removal is stated as removal, not activity', () => {
  const s = summarizeChanges([
    file('src/a.ts', { added: 0, removed: 45 }),
    file('src/b.ts', { added: 0, removed: 12 }),
  ]);
  assert.match(s.headline, /Nothing new was written — 57 lines came out\./);
});

test('net-negative change leads with what came out', () => {
  const s = summarizeChanges([file('src/a.ts', { added: 20, removed: 90 })]);
  assert.match(s.headline, /More came out than went in: 90 lines removed, 20 added\./);
});

test('a rename names both ends', () => {
  const s = summarizeChanges([
    file('src/new-name.ts', { kind: 'renamed', from: 'src/old-name.ts', added: 0, removed: 0 }),
  ]);
  assert.match(s.headline, /renamed src\/old-name\.ts to src\/new-name\.ts/i);
});

test('binary files are explained in words, not shown as dashes', () => {
  const s = summarizeChanges([
    file('assets/logo.png', { kind: 'new', added: null, removed: null, binary: true }),
  ]);
  assert.match(s.headline, /can’t be shown as text/);
  assert.ok(!/-\t-|\bnull\b|\bNaN\b/.test(s.headline));
});

test('mixed text and binary counts both', () => {
  const s = summarizeChanges([
    file('src/a.ts', { added: 30, removed: 0 }),
    file('img/x.png', { binary: true, added: null, removed: null }),
    file('img/y.png', { binary: true, added: null, removed: null }),
  ]);
  assert.match(s.headline, /2 of the files are images or other files/);
});

test('every produced string stays jargon-free across a stress mix', () => {
  const s = summarizeChanges([
    file('src/a.ts', { added: 200, removed: 40 }),
    file('test/old.spec.js', { kind: 'deleted', added: 0, removed: 300 }),
    file('.env.production', { added: 2, removed: 2 }),
    file('bin/tool', { binary: true, added: null, removed: null }),
    file('package.json', { added: 1, removed: 1 }),
  ]);
  assertNoJargon([s.headline, ...s.cautions].join('\n'));
});
