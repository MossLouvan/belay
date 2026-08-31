// The changes collector is the third surface standing next to a write path,
// so these tests lead with confinement — escape attempts must fail before git
// runs — and then exercise the real git cases against a sandbox repo under
// $HOME: dirty, clean, not-a-repo, no-commits-yet, binary, and the diff cap.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { collectChanges, capDiff, parseStatus, parseNumstat, DIFF_CAP } from '../src/changes.js';

const HOME = homedir();
let sandbox = '';   // inside home: repos under test
let outside = '';   // outside every root: escape target

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
};

/** A minimal repo with one committed file, so HEAD exists. */
async function makeRepo(name: string): Promise<string> {
  const dir = join(sandbox, name);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  await writeFile(join(dir, 'kept.txt'), 'one\ntwo\nthree\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

before(async () => {
  outside = await mkdtemp(join(tmpdir(), 'tether-changes-outside-'));
  sandbox = join(HOME, '.tether-test-changes');
  await rm(sandbox, { recursive: true, force: true });
  await mkdir(sandbox, { recursive: true });
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ---- confinement: this route must not be the weak surface ------------------

test('a folder outside the roots is refused before git runs', async () => {
  await assert.rejects(() => collectChanges(outside), /outside the allowed folders/);
});

test('lexical traversal out of the roots is refused', async () => {
  await assert.rejects(
    () => collectChanges(join(sandbox, '..', '..', '..', 'etc')),
    /outside|no longer exists/,
  );
});

test('a symlink that resolves outside the roots is refused', async () => {
  const link = join(sandbox, 'link-out');
  await symlink(outside, link);
  await assert.rejects(() => collectChanges(link), /outside the allowed folders/);
});

test('a deny-listed folder inside a root is refused with the same message', async () => {
  await assert.rejects(() => collectChanges(join(HOME, '.ssh')), /outside the allowed folders/);
});

test('a vanished folder reports plainly, not with a raw ENOENT', async () => {
  await assert.rejects(() => collectChanges(join(sandbox, 'never-existed')), /no longer exists/);
});

// ---- git cases -------------------------------------------------------------

test('a folder with no git history says so in plain words', async () => {
  const dir = join(sandbox, 'plain');
  await mkdir(dir);
  const out = await collectChanges(dir);
  assert.equal(out.repo, false);
  assert.match(out.summary.headline, /doesn’t keep change history/);
  assert.ok(!/git|repo/i.test(out.summary.headline));
});

test('a clean repo reports clean with the no-changes headline', async () => {
  const dir = await makeRepo('clean');
  const out = await collectChanges(dir);
  assert.equal(out.repo, true);
  assert.equal(out.clean, true);
  assert.equal(out.files.length, 0);
  assert.equal(out.diff, '');
  assert.match(out.summary.headline, /No changes/);
});

test('edits, new files and deletions are all seen, with counts and a diff', async () => {
  const dir = await makeRepo('dirty');
  await writeFile(join(dir, 'kept.txt'), 'one\nTWO\nthree\nfour\n'); // edit
  await writeFile(join(dir, 'fresh.txt'), 'a\nb\nc\n');              // untracked
  await rm(join(dir, 'kept.txt')).then(() => writeFile(join(dir, 'kept.txt'), 'one\nTWO\nthree\nfour\n'));
  const out = await collectChanges(dir);
  assert.equal(out.clean, false);
  const kinds = new Map(out.files.map((f) => [f.path, f.kind]));
  assert.equal(kinds.get('kept.txt'), 'edited');
  assert.equal(kinds.get('fresh.txt'), 'new');
  const fresh = out.files.find((f) => f.path === 'fresh.txt')!;
  assert.equal(fresh.added, 3); // counted via --no-index against the empty file
  assert.match(out.diff, /\+TWO/);
  assert.match(out.diff, /\+b\n/); // the untracked file's content is in the diff too
  assert.equal(out.diffTruncated, false);
  assert.match(out.summary.headline, /^Claude /);
});

test('a deleted file surfaces as a deletion caution end-to-end', async () => {
  const dir = await makeRepo('deleting');
  await rm(join(dir, 'kept.txt'));
  const out = await collectChanges(dir);
  assert.equal(out.files[0]!.kind, 'deleted');
  assert.match(out.summary.cautions[0]!, /deleted/i);
  assert.match(out.summary.cautions[0]!, /kept\.txt/);
});

test('a binary file is marked binary and never breaks the counts', async () => {
  const dir = await makeRepo('binary');
  await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
  const out = await collectChanges(dir);
  const blob = out.files.find((f) => f.path === 'blob.bin')!;
  assert.equal(blob.kind, 'new');
  assert.equal(blob.binary, true);
  assert.equal(blob.added, null);
  assert.match(out.summary.headline, /can’t be shown as text/);
});

test('a repo with no commits yet treats everything as new instead of erroring', async () => {
  const dir = join(sandbox, 'unborn');
  await mkdir(dir);
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'first.txt'), 'hello\n');
  const out = await collectChanges(dir);
  assert.equal(out.repo, true);
  assert.equal(out.clean, false);
  assert.equal(out.files[0]!.kind, 'new');
  assert.equal(out.files[0]!.added, 1);
});

test('an enormous diff is capped on a line boundary and flagged', async () => {
  const dir = await makeRepo('huge');
  const big = Array.from({ length: 30_000 }, (_, i) => `line number ${i} of a very large generated file`).join('\n');
  await writeFile(join(dir, 'huge.txt'), big + '\n');
  const out = await collectChanges(dir);
  assert.equal(out.diffTruncated, true);
  assert.ok(out.diff.length <= DIFF_CAP);
  assert.ok(out.diff.endsWith('\n')); // cut on a whole line, not mid-character
  const huge = out.files.find((f) => f.path === 'huge.txt')!;
  assert.equal(huge.added, 30_000); // counts stay exact even when the text is cut
});

test('a staged rename is reported as a rename with its origin', async () => {
  const dir = await makeRepo('renaming');
  git(dir, 'mv', 'kept.txt', 'moved.txt');
  const out = await collectChanges(dir);
  const moved = out.files.find((f) => f.path === 'moved.txt')!;
  assert.equal(moved.kind, 'renamed');
  assert.equal(moved.from, 'kept.txt');
  assert.match(out.summary.headline, /renamed kept\.txt to moved\.txt/);
});

// ---- parsers and the cap, as pure units ------------------------------------

test('parseStatus handles ordinary, untracked, deleted and renamed entries', () => {
  const raw = ' M a.txt\0?? b.txt\0 D c.txt\0R  new.txt\0old.txt\0';
  const entries = parseStatus(raw);
  assert.deepEqual(entries.map((e) => [e.path, e.kind]), [
    ['a.txt', 'edited'], ['b.txt', 'new'], ['c.txt', 'deleted'], ['new.txt', 'renamed'],
  ]);
  assert.equal(entries[3]!.from, 'old.txt');
});

test('parseStatus keeps a filename containing spaces and quotes intact', () => {
  const entries = parseStatus(' M has "quotes" and spaces.txt\0');
  assert.equal(entries[0]!.path, 'has "quotes" and spaces.txt');
});

test('parseNumstat reads counts, binary dashes, and rename records', () => {
  const raw = ['10\t2\ta.txt', '-\t-\tblob.png', '3\t1\t', 'old.txt', 'new.txt', ''].join('\0');
  const counts = parseNumstat(raw);
  assert.deepEqual(counts.get('a.txt'), { added: 10, removed: 2 });
  assert.deepEqual(counts.get('blob.png'), { added: null, removed: null });
  assert.deepEqual(counts.get('new.txt'), { added: 3, removed: 1 });
});

test('capDiff cuts on the last full line under the cap', () => {
  const text = 'aaaa\nbbbb\ncccc\n';
  const capped = capDiff(text, 10);
  assert.deepEqual(capped, { text: 'aaaa\nbbbb\n', truncated: true });
  assert.deepEqual(capDiff(text, 100), { text, truncated: false });
});
