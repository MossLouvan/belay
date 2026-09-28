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

test('secret files are denied by name wherever they sit, case-insensitively', () => {
  const inProject = (name: string) => join(HOME, 'Documents', 'project', name);
  for (const f of ['.env', '.env.local', '.ENV.production', '.git-credentials', '.netrc', '.npmrc', 'attach-secret', 'hook-secret']) {
    assert.equal(isDenied(inProject(f)), true, f);
  }
  assert.equal(isDenied(join(HOME, '.belay', 'attach-secret')), true);
  assert.equal(isDenied(join(HOME, '.belay', 'hook-secret')), true);
  assert.equal(isDenied(join(HOME, '.aws', 'credentials')), true);
  assert.equal(isDenied(join(HOME, '.git-credentials')), true);
});

test('browser cookie and login stores are denied on every platform layout', () => {
  const stores = [
    ['Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'],
    ['Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Login Data'],
    ['Library', 'Application Support', 'Microsoft Edge', 'Default', 'Cookies'],
    ['Library', 'Application Support', 'Firefox', 'Profiles', 'abc.default', 'logins.json'],
    ['Library', 'Cookies', 'Cookies.binarycookies'],
    ['Library', 'Safari', 'History.db'],
    ['Library', 'Keychains', 'login.keychain-db'],
    ['AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'],
    ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies'],
    ['AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'x', 'key4.db'],
    ['.mozilla', 'firefox', 'x', 'cookies.sqlite'],
  ];
  for (const parts of stores) assert.equal(isDenied(join(HOME, ...parts)), true, parts.join('/'));
  // A copied profile in an ordinary folder is still refused by file name.
  for (const f of ['Cookies', 'login data', 'logins.json', 'key4.db', 'cookies.sqlite']) {
    assert.equal(isDenied(join(HOME, 'Desktop', 'backup', f)), true, f);
  }
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
