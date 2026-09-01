// Where a session is allowed to run. `POST /agent/sessions` used to accept
// any directory on the machine — strictly weaker than the write path in
// projects.ts, which realpaths and confines everything to the file-browser
// roots. A session cwd is not a write primitive, but it is an *execution*
// primitive: Claude runs commands there, reads whatever the folder holds,
// and the folder name lands in shell prompts and logs. So the same rules
// apply, tested the same way: real directories and real symlinks under
// $HOME, because lexical checks have already been shown insufficient there.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { resolveSessionCwd } from '../src/agent.js';
import { isInsideRoots } from '../src/files.js';

const HOME = homedir();

// A directory *outside* every allowed root, which escape attempts aim at.
let outside = '';
// A working sandbox *inside* home holding the folders (and links) under test.
let inside = '';

before(async () => {
  outside = await mkdtemp(join(tmpdir(), 'belay-agent-cwd-outside-'));
  inside = join(HOME, '.belay-test-agent-cwd');
  await rm(inside, { recursive: true, force: true });
  await mkdir(inside, { recursive: true });
  await mkdir(join(inside, 'project'));
  await writeFile(join(inside, 'a-file.txt'), 'not a folder\n', 'utf8');
  await symlink(outside, join(inside, 'link-to-outside'));
});

after(async () => {
  await rm(inside, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ---- what still works ------------------------------------------------------

test('a real folder inside the roots resolves', () => {
  const resolved = resolveSessionCwd(join(inside, 'project'));
  assert.ok(isInsideRoots(resolved));
});

test('~ expands to the host home', () => {
  const resolved = resolveSessionCwd('~/.belay-test-agent-cwd/project');
  assert.equal(resolved, join(inside, 'project'));
});

test('a missing folder is still rejected', () => {
  assert.throws(() => resolveSessionCwd(join(inside, 'nope')), /folder/i);
});

test('a file is still rejected', () => {
  assert.throws(() => resolveSessionCwd(join(inside, 'a-file.txt')), /folder/i);
});

// ---- confinement -----------------------------------------------------------

test('a cwd outside the roots is rejected', () => {
  assert.throws(() => resolveSessionCwd(outside), /outside/i);
});

test('lexical .. traversal out of the roots is rejected', () => {
  // Enough `..` to reach / from anywhere under $HOME, then into the escape dir.
  const escape = join(inside, '..', '..', '..', '..', '..', '..', ...outside.split('/').filter(Boolean));
  assert.throws(() => resolveSessionCwd(escape), /outside/i);
});

test('a symlink that resolves outside the roots is rejected', () => {
  assert.throws(() => resolveSessionCwd(join(inside, 'link-to-outside')), /outside/i);
});

test('deny-listed locations are rejected even though they are under a root', () => {
  // process.cwd() is the server install dir, on the deny-list because it holds
  // the paired-device tokens; a Claude session running there could exfiltrate
  // them with a single approved Read.
  assert.throws(() => resolveSessionCwd(process.cwd()), /outside/i);
});

test('the resolved path is the real path, so later spawns cannot be re-aimed lexically', () => {
  // Even for an allowed folder, what comes back must be symlink-free: the
  // string is later handed to spawn() as-is, and confinement decided on one
  // path but executed on another would be no confinement at all.
  const viaDots = join(inside, 'project', '..', 'project');
  assert.equal(resolveSessionCwd(viaDots), resolveSessionCwd(join(inside, 'project')));
});
