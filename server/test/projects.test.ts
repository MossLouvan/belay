// Project creation is the server's first write path, so these tests lead with
// the attacks rather than the happy path: traversal in the name, traversal in
// the parent, a symlinked parent that resolves outside the roots, and the
// overwrite case. The same sandbox pattern as files.test.ts — real directories
// and real symlinks under $HOME — because lexical checks alone have already
// been shown insufficient there.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { createProject, defaultProjectParent } from '../src/projects.js';
import { isInsideRoots } from '../src/files.js';

const HOME = homedir();

// A directory *outside* every allowed root, which escape attempts aim at.
let outside = '';
// A working sandbox *inside* home holding the parents (and links) under test.
let inside = '';

before(async () => {
  outside = await mkdtemp(join(tmpdir(), 'belay-projects-outside-'));
  inside = join(HOME, '.belay-test-projects');
  await rm(inside, { recursive: true, force: true });
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, 'a-file.txt'), 'not a folder\n', 'utf8');
  await mkdir(join(inside, 'taken'));
  await symlink(outside, join(inside, 'link-to-outside'));
});

after(async () => {
  await rm(inside, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ---- name validation: a name is one path segment, never a path -------------

test('non-string and empty names are rejected', async () => {
  for (const bad of [undefined, null, 42, {}, '', '   ', '\t\n']) {
    await assert.rejects(() => createProject(bad, inside), /name/i, String(bad));
  }
});

test('names containing path separators are rejected', async () => {
  for (const bad of ['a/b', '/abs', 'a\\b', '\\\\share', 'trailing/']) {
    await assert.rejects(() => createProject(bad, inside), /name/i, bad);
  }
});

test('dot names, .. and leading dots are rejected', async () => {
  for (const bad of ['.', '..', '...', '.hidden', '.ssh']) {
    await assert.rejects(() => createProject(bad, inside), /name/i, bad);
  }
});

test('NUL bytes, control characters and absurd lengths are rejected', async () => {
  await assert.rejects(() => createProject('evil\0name', inside), /name/i);
  await assert.rejects(() => createProject('evil\nname', inside), /name/i);
  await assert.rejects(() => createProject('x'.repeat(129), inside), /name/i);
});

test('no directory is created by any rejected name', () => {
  // The traversal names above must not have left anything behind anywhere
  // near the sandbox.
  assert.ok(!existsSync(join(inside, 'a')));
  assert.ok(!existsSync(join(inside, 'evil')));
});

// ---- parent confinement ----------------------------------------------------

test('a parent outside the roots is rejected', async () => {
  await assert.rejects(() => createProject('proj', outside), /outside/i);
  assert.ok(!existsSync(join(outside, 'proj')));
});

test('lexical .. traversal in the parent is rejected', async () => {
  const escape = join(inside, '..', '..', '..', '..', 'tmp');
  await assert.rejects(() => createProject('proj', escape), /outside|exist/i);
});

test('a symlinked parent resolving outside the roots is rejected', async () => {
  await assert.rejects(
    () => createProject('proj', join(inside, 'link-to-outside')),
    /outside/i,
  );
  assert.ok(!existsSync(join(outside, 'proj')), 'symlink escape must not create anything');
});

test('the Belay install directory is refused as a parent', async () => {
  // process.cwd() is the server install dir, on the deny-list because it holds
  // the paired-device tokens; a project created there would be served back out.
  await assert.rejects(() => createProject('proj', process.cwd()), /outside/i);
});

test('a missing parent is rejected, not created recursively', async () => {
  const missing = join(inside, 'missing', 'deep');
  await assert.rejects(() => createProject('proj', missing), /exist/i);
  assert.ok(!existsSync(join(inside, 'missing')), 'must not mkdir -p the parent chain');
});

test('a file as parent is rejected', async () => {
  await assert.rejects(() => createProject('proj', join(inside, 'a-file.txt')), /folder/i);
});

test('non-string parents are rejected', async () => {
  for (const bad of [undefined, null, 7, {}, '']) {
    await assert.rejects(() => createProject('proj', bad), /parent/i, String(bad));
  }
});

// ---- overwrite refusal -----------------------------------------------------

test('an existing directory is never overwritten', async () => {
  await assert.rejects(() => createProject('taken', inside), /exists/i);
});

test('an existing file with the same name is never overwritten', async () => {
  await assert.rejects(() => createProject('a-file.txt', inside), /exists/i);
});

// ---- happy path ------------------------------------------------------------

test('a valid name under a valid parent creates the directory', async () => {
  const project = await createProject('  my-app  ', inside);
  assert.equal(project.name, 'my-app');
  assert.equal(project.path, join(inside, 'my-app'));
  assert.equal(project.recent, true);
  assert.ok(statSync(project.path).isDirectory());
});

test('creating the same project twice fails the second time', async () => {
  await createProject('twice', inside);
  await assert.rejects(() => createProject('twice', inside), /exists/i);
});

// ---- default parent --------------------------------------------------------

test('the default parent is an existing directory inside the roots', () => {
  const parent = defaultProjectParent();
  assert.ok(statSync(parent).isDirectory());
  assert.ok(isInsideRoots(parent) || parent === HOME);
});
