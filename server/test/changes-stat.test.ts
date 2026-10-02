// The one-line "what changed" that rides a done notice: git's own shortstat
// plus the untracked count, or nothing at all when git cannot answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { changeStat, parseShortstat } from '../src/changes-stat.js';

const git = (dir: string, ...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'belay-stat-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('parseShortstat reads every shape git prints', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 41 insertions(+), 7 deletions(-)\n'), { files: 3, insertions: 41, deletions: 7 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 deletion(-)'), { files: 1, insertions: 0, deletions: 1 });
  assert.deepEqual(parseShortstat(''), { files: 0, insertions: 0, deletions: 0 });
});

test('a dirty repo: edited lines from shortstat, untracked files counted in', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'one\nthree\nfour\n');
  writeFileSync(join(dir, 'new.txt'), 'hi\n');
  assert.deepEqual(await changeStat(dir), { files: 2, insertions: 2, deletions: 1, cwd: dir });
});

test('a clean repo is all zeros; a non-repo or missing folder is undefined', async () => {
  const clean = repo();
  assert.deepEqual(await changeStat(clean), { files: 0, insertions: 0, deletions: 0, cwd: clean });
  const plain = mkdtempSync(join(tmpdir(), 'belay-stat-plain-'));
  assert.equal(await changeStat(plain), undefined);
  assert.equal(await changeStat(join(plain, 'nope')), undefined);
});
