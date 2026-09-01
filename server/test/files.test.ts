// Path-confinement tests for the file browser. The interesting case on macOS
// is the symlink escape: `resolve()` collapses `..` but does not follow
// symlinks, so a link inside an allowed root used to hand out the whole
// filesystem. These tests create a real link under $HOME and prove it cannot.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

import { listDir, readTextFile, isInsideRoots, ROOTS } from '../src/files.js';

const HOME = homedir();

// A sandbox *outside* the roots that the escape attempts will aim at.
let outside = '';
let outsideFile = '';
// A working directory *inside* home, holding the links under test.
let inside = '';

before(async () => {
  outside = await mkdtemp(join(tmpdir(), 'belay-outside-'));
  outsideFile = join(outside, 'secret.txt');
  await writeFile(outsideFile, 'top secret\n', 'utf8');

  inside = join(HOME, '.belay-test-sandbox');
  await rm(inside, { recursive: true, force: true });
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, 'ok.txt'), 'inside content\n', 'utf8');
  await symlink(outsideFile, join(inside, 'link-to-secret.txt'));
  await symlink(outside, join(inside, 'link-to-outside-dir'));
  await symlink(join(inside, 'ok.txt'), join(inside, 'link-inside.txt'));
});

after(async () => {
  await rm(inside, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('the roots list always includes Home and only existing directories', () => {
  assert.ok(ROOTS.some((r) => r.name === 'Home' && r.path === HOME));
  assert.ok(ROOTS.length > 0);
});

test('isInsideRoots accepts a root itself and paths beneath it', () => {
  assert.equal(isInsideRoots('/a/b', ['/a/b']), true);
  assert.equal(isInsideRoots('/a/b/c/d', ['/a/b']), true);
});

test('isInsideRoots rejects a sibling with the same prefix', () => {
  // The classic prefix bug: /a/bad must not match the root /a/b.
  assert.equal(isInsideRoots('/a/bad', ['/a/b']), false);
  assert.equal(isInsideRoots('/other', ['/a/b']), false);
});

test('lexical .. traversal is rejected', async () => {
  await assert.rejects(
    () => listDir(join(HOME, '..', '..', '..', 'etc')),
    /outside the allowed roots/,
  );
});

test('an absolute path outside the roots is rejected', async () => {
  await assert.rejects(() => readTextFile(outsideFile), /outside the allowed roots/);
});

test('a symlink inside home pointing at a file outside cannot be read', async () => {
  // Sanity: the target really is readable, so a pass here means the guard
  // blocked it rather than the file being missing.
  assert.equal(await readFile(outsideFile, 'utf8'), 'top secret\n');
  await assert.rejects(
    () => readTextFile(join(inside, 'link-to-secret.txt')),
    /outside the allowed roots/,
  );
});

test('a symlink inside home pointing at a directory outside cannot be listed', async () => {
  await assert.rejects(
    () => listDir(join(inside, 'link-to-outside-dir')),
    /outside the allowed roots/,
  );
});

test('escaping symlinks are omitted from listings entirely', async () => {
  const { entries } = await listDir(inside);
  const names = entries.map((e) => e.name);
  assert.ok(!names.includes('link-to-secret.txt'), 'escaping file symlink must not be listed');
  assert.ok(!names.includes('link-to-outside-dir'), 'escaping dir symlink must not be listed');
  assert.ok(names.includes('ok.txt'));
  assert.ok(names.includes('link-inside.txt'), 'in-root symlinks stay usable');
});

test('a symlink that stays inside the roots still resolves and reads', async () => {
  const file = await readTextFile(join(inside, 'link-inside.txt'));
  assert.equal(file.content, 'inside content\n');
  // The reported path is the real one, not the link.
  assert.equal(file.path, join(inside, 'ok.txt'));
});

test('a normal file inside the roots reads back correctly', async () => {
  const file = await readTextFile(join(inside, 'ok.txt'));
  assert.equal(file.name, 'ok.txt');
  assert.equal(file.truncated, false);
  assert.equal(file.content, 'inside content\n');
});

test('a missing path reports "does not exist", not a confinement error', async () => {
  await assert.rejects(() => readTextFile(join(inside, 'nope.txt')), /does not exist/);
});

test('reading a directory is refused', async () => {
  await assert.rejects(() => readTextFile(inside), /is a directory/);
});

// --- Case-insensitive filesystems (APFS/NTFS default) -----------------------
// The prefix check in isInsideRoots is case-sensitive, which is only safe while
// both the roots and the user paths are canonicalised the same way. These tests
// pin that property down so a future "use the cheaper realpath" change fails
// here instead of quietly opening a case-based bypass.

/** True when the sandbox's filesystem treats OK.TXT and ok.txt as one file. */
function caseInsensitive(): boolean {
  return existsSync(join(inside, 'OK.TXT'));
}

test('a wrong-case path inside the roots still resolves to the real file', async (t) => {
  if (!caseInsensitive()) return t.skip('filesystem is case-sensitive');
  const wrongCase = join(HOME, '.BELAY-TEST-SANDBOX', 'OK.TXT');
  const file = await readTextFile(wrongCase);
  assert.equal(file.content, 'inside content\n');
  // Canonical, on-disk casing — not the caller's spelling.
  assert.equal(file.path, join(inside, 'ok.txt'));
});

test('a wrong-case path outside the roots is still rejected', async (t) => {
  if (!caseInsensitive()) return t.skip('filesystem is case-sensitive');
  const wrongCase = join(dirname(outsideFile), basename(outsideFile).toUpperCase());
  await assert.rejects(() => readTextFile(wrongCase), /outside the allowed roots/);
});

test('realpath canonicalises case identically for roots and user paths', async (t) => {
  if (!caseInsensitive()) return t.skip('filesystem is case-sensitive');
  const wrongCase = join(HOME, '.BELAY-TEST-SANDBOX');
  // This is the exact behavioural property files.ts depends on: the native
  // realpath (used for REAL_ROOTS) matches fs.promises.realpath (used for
  // caller paths). The legacy JS realpathSync does NOT canonicalise case,
  // which is why files.ts must not use it.
  assert.equal(realpathSync.native(wrongCase), await realpath(wrongCase));
  assert.equal(realpathSync.native(wrongCase), inside);
});

test('listing home works and returns real, absolute paths', async () => {
  const { path, entries } = await listDir(HOME);
  assert.equal(path, HOME);
  assert.ok(entries.every((e) => e.path.startsWith(HOME)));
  // Directories sort before files.
  const firstFile = entries.findIndex((e) => !e.dir);
  const lastDir = entries.map((e) => e.dir).lastIndexOf(true);
  if (firstFile !== -1 && lastDir !== -1) assert.ok(lastDir < firstFile);
});

// --- Distinguishable errors for "paste a path and go" ------------------------
// The Files tab lets a user type a path directly, so the three ways a path can
// be wrong must come back as three different messages the app can show as-is:
// outside the roots, missing, and "that's a file". Before this, listing a file
// leaked a raw ENOTDIR with the scandir syscall detail in it.

test('listing a path outside the roots names confinement, not existence', async () => {
  await assert.rejects(() => listDir(outside), /outside the allowed roots/);
});

test('listing a missing path says it does not exist', async () => {
  await assert.rejects(() => listDir(join(inside, 'no-such-dir')), /does not exist/);
});

test('listing a file says it is a file, without syscall noise', async () => {
  await assert.rejects(() => listDir(join(inside, 'ok.txt')), (e: Error) => {
    assert.match(e.message, /is a file, not a folder/);
    assert.doesNotMatch(e.message, /ENOTDIR|scandir/);
    return true;
  });
});
