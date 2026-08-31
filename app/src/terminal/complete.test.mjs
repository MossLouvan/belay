// Unit tests for the tab-completion echo replay and classifier in ./complete.ts.
//
// Same arrangement as ../terminal-ansi.test.mjs: plain ESM importing the .ts
// module directly (Node strips the types), run by `node --test`. Every raw
// string below is a captured-echo shape a real shell produces — the comments
// name which shell and which behaviour each one imitates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCandidate, interpretEcho, lastWord, parseCompletion } from './complete.ts';

// --- echo replay -------------------------------------------------------------

test('replay: plain echo reconstructs the line', () => {
  assert.deepEqual(interpretEcho('ls foo').lines, ['ls foo']);
});

test('replay: CR + erase-to-end redraw (zsh rewriting the line)', () => {
  const echo = interpretEcho('ls documents\r\x1b[Kls Documents/');
  assert.deepEqual(echo.lines, ['ls Documents/']);
});

test('replay: backspace overwrite and SGR noise are absorbed', () => {
  const echo = interpretEcho('ab\b\x1b[1mc\x1b[0m');
  assert.deepEqual(echo.lines, ['ac']);
  assert.equal(echo.unreadable, false);
});

test('replay: OSC title sequences are skipped whole', () => {
  assert.deepEqual(interpretEcho('\x1b]0;title\x07ls').lines, ['ls']);
});

test('replay: bell is reported, not printed', () => {
  const echo = interpretEcho('ls zz\x07');
  assert.equal(echo.bell, true);
  assert.deepEqual(echo.lines, ['ls zz']);
});

test('replay: vertical or absolute cursor moves mark the echo unreadable', () => {
  assert.equal(interpretEcho('x\x1b[2;5Hy').unreadable, true);
  assert.equal(interpretEcho('x\x1b[Ay').unreadable, true);
  assert.equal(interpretEcho('x\x1b[2Jy').unreadable, true);
});

test('replay: a CSI split at the end of the capture is dropped, not printed', () => {
  assert.deepEqual(interpretEcho('ls\x1b[3').lines, ['ls']);
});

// --- word boundaries ---------------------------------------------------------

test('lastWord: basename after the last slash', () => {
  assert.deepEqual(lastWord('cat src/ter'), { baseStart: 8, base: 'ter', quote: null });
});

test('lastWord: backslash-escaped space stays inside the word', () => {
  const w = lastWord('ls My\\ Doc');
  assert.equal(w.base, 'My Doc');
  assert.equal(w.baseStart, 3);
});

test('lastWord: an open double quote is reported', () => {
  const w = lastWord('ls "My Doc');
  assert.equal(w.base, 'My Doc');
  assert.equal(w.quote, '"');
});

// --- classification ----------------------------------------------------------

test('unique completion: the shell appends the suffix (zsh/bash)', () => {
  // We wrote "ls fo"; the pty echoed it, then tab echoed the rest.
  const result = parseCompletion('ls fo', 'ls fo' + 'o.txt ');
  assert.deepEqual(result, { kind: 'line', line: 'ls foo.txt' });
});

test('unique completion: a rewrite (case correction) is taken wholesale', () => {
  const raw = 'ls documents\r\x1b[Kls Documents/';
  assert.deepEqual(parseCompletion('ls documents', raw), { kind: 'line', line: 'ls Documents/' });
});

test('unique completion containing spaces arrives shell-escaped and is kept', () => {
  const raw = 'ls My\\ Documents/';
  assert.deepEqual(parseCompletion('ls My', raw), { kind: 'line', line: 'ls My\\ Documents/' });
});

test('ambiguous: candidate columns split, prompt redraw line dropped', () => {
  const raw = 'ls f\x07\r\nfoo/     fab.txt\r\nuser@mac % ls f';
  const result = parseCompletion('ls f', raw);
  assert.equal(result.kind, 'candidates');
  assert.deepEqual(result.candidates, ['foo/', 'fab.txt']);
  // "f" is already the common prefix, so the line is untouched.
  assert.equal(result.line, 'ls f');
});

test('ambiguous: the line advances to the common prefix of the candidates', () => {
  const raw = 'ls f\x07\r\nfoo-a.txt  foo-b.txt\r\n% ls f';
  const result = parseCompletion('ls f', raw);
  assert.equal(result.kind, 'candidates');
  assert.equal(result.line, 'ls foo-');
});

test('ambiguous with a spaced word: the extension is escaped on insertion', () => {
  const raw = 'ls My\x07\r\nMy Documents/  My Downloads/\r\n% ls My';
  const result = parseCompletion('ls My', raw);
  assert.equal(result.kind, 'candidates');
  assert.equal(result.line, 'ls My\\ Do');
});

test('no match: bell and an unchanged line', () => {
  assert.deepEqual(parseCompletion('ls zz', 'ls zz\x07'), { kind: 'none' });
});

test('timeout: an empty capture is "none", never a corrupted line', () => {
  assert.deepEqual(parseCompletion('ls fo', ''), { kind: 'none' });
});

test('huge list: only the y/n question printed means nothing to offer', () => {
  const raw = 'l\x07\r\nzsh: do you wish to see all 1423 possibilities (712 lines)?\r\n% l';
  assert.deepEqual(parseCompletion('l', raw), { kind: 'none' });
});

test('a soft-wrapped echo that replays as a tail fragment is refused', () => {
  // zsh wrapping at the pty edge: space + CR, then the rest of the line on the
  // next visual row — which a wrap-blind replay overwrites into a fragment.
  const raw = 'ls /deep/pa \r\x1b[Kt\rth/unique-file.txt';
  assert.deepEqual(parseCompletion('ls /deep/pat', raw), { kind: 'unreadable' });
});

test('unreadable echo (ConPTY repaints) refuses rather than guesses', () => {
  const raw = 'Get-Ch\x1b[24;1HGet-ChildItem';
  assert.deepEqual(parseCompletion('Get-Ch', raw), { kind: 'unreadable' });
});

// --- reconciliation ----------------------------------------------------------

test('applyCandidate: replaces the trailing basename and escapes spaces', () => {
  assert.equal(applyCandidate('ls My', 'My Documents/'), 'ls My\\ Documents/');
});

test('applyCandidate: splices after the directory part, not the whole token', () => {
  assert.equal(applyCandidate('cat src/ter', 'terminal-ansi.ts'), 'cat src/terminal-ansi.ts');
});

test('applyCandidate: inside an open quote the text goes in raw', () => {
  assert.equal(applyCandidate('ls "My', 'My Documents/'), 'ls "My Documents/');
});

test('applyCandidate: a candidate for an escaped word replaces it cleanly', () => {
  assert.equal(applyCandidate('ls My\\ Doc', 'My Documents/'), 'ls My\\ Documents/');
});

test('zsh list captured live: erase-below, columns, climb back up to the prompt', () => {
  // Verbatim shape from a real zsh 5.9 pty: echo + bell, CR CR LF, ESC[J, the
  // candidate columns, then cursor-up and a forward-jump redraw of the line.
  const sent = 'ls comp-test/alpha-';
  const raw =
    'l\bls comp-test/alpha-\x07\r\r\n\x1b[Jalpha-one.txt  alpha-two.txt' +
    '\x1b[A\x1b[0m\x1b[27m\x1b[24m\r\x1b[33Cls comp-test/alpha-\x1b[K';
  const result = parseCompletion(sent, raw);
  assert.equal(result.kind, 'candidates');
  assert.deepEqual(result.candidates, ['alpha-one.txt', 'alpha-two.txt']);
  assert.equal(result.line, sent);
});
