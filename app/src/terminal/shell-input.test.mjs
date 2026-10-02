// What the command field sends: a multi-line paste runs line by line and is
// never flattened (#143); a piped shell gets the command echoed locally (#144).
//
//   cd app && node --test src/terminal/shell-input.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pipeEcho, runBytes, shellLines, typeBytes } from './shell-input.ts';

test('a single line runs as itself plus return', () => {
  assert.equal(runBytes('ls -la'), 'ls -la\r');
  assert.equal(typeBytes('ls -la'), 'ls -la');
});

test('an empty run is just the return', () => {
  assert.equal(runBytes(''), '\r');
  assert.equal(typeBytes(''), '');
});

test('a pasted multi-line snippet runs one line at a time', () => {
  assert.equal(runBytes('echo line1\necho line2'), 'echo line1\recho line2\r');
  assert.equal(runBytes('cd foo\r\nnpm test\n'), 'cd foo\rnpm test\r', 'CRLF and a trailing newline are one terminator each');
});

test('TYPE runs every complete line but parks the last one at the prompt', () => {
  assert.equal(typeBytes('cd foo\nnpm test'), 'cd foo\rnpm test');
});

test('shellLines drops only the trailing empty line', () => {
  assert.deepEqual(shellLines('a\n\nb\n'), ['a', '', 'b']);
  assert.deepEqual(shellLines('a'), ['a']);
});

test('pipe echo writes each command as a dim prompt line', () => {
  assert.equal(pipeEcho('echo hi'), '\x1b[2m$ echo hi\x1b[22m\r\n');
  assert.equal(pipeEcho('a\nb'), '\x1b[2m$ a\x1b[22m\r\n\x1b[2m$ b\x1b[22m\r\n');
  assert.equal(pipeEcho(''), '\x1b[2m$ \x1b[22m\r\n');
});
