// The deny layer on top of the root allow-list: places inside a root that
// must never be served because they hold credentials — above all the Belay
// install directory, whose state file carries every paired device's token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isDenied, readTextFile, listDir } from '../src/files.js';

const HOME = homedir();

test('the Belay install directory and its state file are denied', () => {
  assert.equal(isDenied(process.cwd()), true);
  assert.equal(isDenied(join(process.cwd(), 'belay-state.json')), true);
  assert.equal(isDenied(join(process.cwd(), 'src', 'index.ts')), true);
  assert.equal(isDenied(join(HOME, 'Documents', 'elsewhere', 'belay-state.json')), true);
  assert.equal(isDenied(join(HOME, 'Documents', 'elsewhere', 'TETHER-AGENT.JSON')), true);
  // The pre-rename filenames stay denied: a machine that paired before the
  // rename still has tether-state.json on disk, holding live tokens.
  assert.equal(isDenied(join(HOME, 'Documents', 'elsewhere', 'tether-state.json')), true);
  assert.equal(isDenied(join(HOME, 'Documents', 'elsewhere', 'belay-agent.json')), true);
});

test('credential folders under home are denied, case-insensitively', () => {
  for (const d of ['.ssh', '.aws', '.claude', '.gnupg', '.netrc', '.bash_history']) {
    assert.equal(isDenied(join(HOME, d)), true, d);
    assert.equal(isDenied(join(HOME, d, 'anything')), true, d);
  }
  assert.equal(isDenied(join(HOME, '.SSH', 'id_rsa')), true);
});

test('ordinary project paths are not denied', () => {
  assert.equal(isDenied(join(HOME, 'Documents', 'project', 'README.md')), false);
  assert.equal(isDenied(join(HOME, 'Desktop')), false);
  assert.equal(isDenied(join(HOME, '.belay-test-sandbox', 'ok.txt')), false);
  // A sibling that merely shares the prefix is not inside the denied dir.
  assert.equal(isDenied(process.cwd() + '-other'), false);
});

test('reading the state file through the file API is refused with the confinement error', async () => {
  await assert.rejects(
    () => readTextFile(join(process.cwd(), 'package.json')),
    /outside the allowed roots/,
  );
  await assert.rejects(() => listDir(process.cwd()), /outside the allowed roots/);
});
