// Unit tests for the Go-to-Folder path cleaner and validator.
//
//   cd app && node --test src/files/paths.test.mjs
//
// Each case covers a real way a path arrives on a phone: pasted from Finder,
// dragged through a terminal, quoted in a chat message.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanPathInput, expandTilde, isUnderRoot, isWindowsPath, parseGoTo } from './paths.ts';

const ROOTS = [
  { name: 'Home', path: '/Users/moss' },
  { name: 'Volumes', path: '/Volumes' },
];

const WIN_ROOTS = [{ name: 'Home', path: 'C:\\Users\\moss' }];

test('a plain absolute path passes through untouched', () => {
  assert.equal(cleanPathInput('/Users/moss/Documents'), '/Users/moss/Documents');
});

test('surrounding whitespace and quotes come off — chat apps add both', () => {
  assert.equal(cleanPathInput('  "/Users/moss/My Stuff"  '), '/Users/moss/My Stuff');
  assert.equal(cleanPathInput("'/Users/moss'"), '/Users/moss');
});

test('terminal drag-and-drop escapes are unwrapped on POSIX paths', () => {
  assert.equal(cleanPathInput('/Users/moss/My\\ Project\\ (v2)'), '/Users/moss/My Project (v2)');
});

test('a Windows path keeps its backslashes — there they ARE the separator', () => {
  assert.equal(cleanPathInput('C:\\Users\\moss\\Desktop'), 'C:\\Users\\moss\\Desktop');
  assert.ok(isWindowsPath('C:\\Users\\moss'));
  assert.ok(!isWindowsPath('/Users/moss'));
});

test('file:// URLs decode, because Finder copies %20 for spaces', () => {
  assert.equal(cleanPathInput('file:///Users/moss/My%20Stuff'), '/Users/moss/My Stuff');
});

test('doubled and trailing separators collapse, but the bare root survives', () => {
  assert.equal(cleanPathInput('/Users//moss/Documents/'), '/Users/moss/Documents');
  assert.equal(cleanPathInput('/'), '/');
  assert.equal(cleanPathInput('C:\\'), 'C:\\');
});

test('tilde expands to the root the host names Home', () => {
  assert.equal(expandTilde('~', ROOTS), '/Users/moss');
  assert.equal(expandTilde('~/Documents', ROOTS), '/Users/moss/Documents');
  assert.equal(expandTilde('/tmp', ROOTS), '/tmp', 'no tilde, no change');
});

test('root confinement is case-insensitive but boundary-exact', () => {
  assert.ok(isUnderRoot('/users/MOSS/documents', ROOTS), 'APFS is case-insensitive');
  assert.ok(isUnderRoot('/Users/moss', ROOTS), 'the root itself is allowed');
  assert.ok(!isUnderRoot('/Users/mossette', ROOTS), 'a sibling sharing the prefix is not');
  assert.ok(!isUnderRoot('/etc', ROOTS));
});

test('Windows roots confine with either slash flavour', () => {
  assert.ok(isUnderRoot('C:\\Users\\moss\\Desktop', WIN_ROOTS));
  assert.ok(isUnderRoot('C:/Users/moss/Desktop', WIN_ROOTS), 'forward slashes are common in pastes');
  assert.ok(!isUnderRoot('D:\\Users\\moss', WIN_ROOTS));
});

test('parseGoTo accepts a valid pasted path, decorations and all', () => {
  const verdict = parseGoTo(' "~/My Docs" ', ROOTS);
  assert.deepEqual(verdict, { ok: true, path: '/Users/moss/My Docs' });
});

test('an empty box asks for input rather than reporting a failure', () => {
  const verdict = parseGoTo('   ', ROOTS);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /paste/i);
});

test('a relative path is refused with the fix spelled out', () => {
  const verdict = parseGoTo('Documents/notes', ROOTS);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /full path/i);
});

test('a path outside the roots names the folders that ARE allowed', () => {
  const verdict = parseGoTo('/etc/passwd', ROOTS);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Home, Volumes/);
});

test('with no roots known yet, confinement is left to the host', () => {
  const verdict = parseGoTo('/anywhere/at/all', []);
  assert.deepEqual(verdict, { ok: true, path: '/anywhere/at/all' });
});
