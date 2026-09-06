// Tests for the claude binary fallback probe: candidate order per platform
// and the pick that stops at the first existing path. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeCandidates, pickClaude } from '../src/claude-path.js';

test('claudeCandidates on macOS: native installer, local install, Homebrew, /usr/local', () => {
  const c = claudeCandidates({ platform: 'darwin', home: '/Users/m', env: {} });
  assert.deepEqual(c, [
    join('/Users/m', '.local', 'bin', 'claude'),
    join('/Users/m', '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
});

test('claudeCandidates on Linux matches macOS minus nothing (Homebrew path is harmless)', () => {
  const c = claudeCandidates({ platform: 'linux', home: '/home/m', env: {} });
  assert.equal(c[0], join('/home/m', '.local', 'bin', 'claude'));
  assert.ok(c.includes('/usr/local/bin/claude'));
  assert.ok(!c.some((p) => p.endsWith('.exe') || p.endsWith('.cmd')));
});

test('claudeCandidates on Windows: .exe names, npm global, Programs folder', () => {
  const c = claudeCandidates({
    platform: 'win32',
    home: 'C:\\Users\\m',
    env: { APPDATA: 'C:\\Users\\m\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local' },
  });
  assert.deepEqual(c, [
    join('C:\\Users\\m', '.local', 'bin', 'claude.exe'),
    join('C:\\Users\\m', '.claude', 'local', 'claude.exe'),
    join('C:\\Users\\m\\AppData\\Roaming', 'npm', 'claude.cmd'),
    join('C:\\Users\\m\\AppData\\Local', 'Programs', 'claude', 'claude.exe'),
  ]);
});

test('claudeCandidates on Windows skips APPDATA/LOCALAPPDATA entries when unset', () => {
  const c = claudeCandidates({ platform: 'win32', home: 'C:\\Users\\m', env: {} });
  assert.equal(c.length, 2);
  assert.ok(!c.some((p) => p.includes('npm') || p.includes('Programs')));
});

test('pickClaude returns the first existing candidate, in order', () => {
  const picked = pickClaude(['/a/claude', '/b/claude', '/c/claude'], (p) => p !== '/a/claude');
  assert.equal(picked, '/b/claude');
});

test('pickClaude returns null when nothing exists and survives a throwing probe', () => {
  assert.equal(pickClaude(['/a', '/b'], () => false), null);
  const picked = pickClaude(['/boom', '/ok'], (p) => { if (p === '/boom') throw new Error('EACCES'); return true; });
  assert.equal(picked, '/ok');
});
