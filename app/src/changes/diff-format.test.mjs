// Unit tests for the diff parser behind the "what changed" screen.
//
//   cd app && node --test src/changes/diff-format.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitDiff, kindWord, countBadge } from './diff-format.ts';

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' context line',
  '-removed line',
  '+added line',
  '+another added',
  'diff --git a/img/logo.png b/img/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/img/logo.png differ',
  '',
].join('\n');

test('a diff splits into one section per file, named by the b-side path', () => {
  const sections = splitDiff(SAMPLE);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].path, 'src/a.ts');
  assert.equal(sections[1].path, 'img/logo.png');
});

test('lines are classified: adds, removes, hunks, and headers as meta', () => {
  const [first] = splitDiff(SAMPLE);
  const kinds = first.lines.map((l) => l.kind);
  assert.deepEqual(kinds, ['meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'add']);
});

test('the +++/--- file headers never read as added/removed code', () => {
  const [first] = splitDiff(SAMPLE);
  const minusHeader = first.lines.find((l) => l.text.startsWith('--- '));
  const plusHeader = first.lines.find((l) => l.text.startsWith('+++ '));
  assert.equal(minusHeader.kind, 'meta');
  assert.equal(plusHeader.kind, 'meta');
});

test('a binary file note is meta, and the trailing blank line is dropped', () => {
  const [, binary] = splitDiff(SAMPLE);
  assert.equal(binary.lines.at(-1).kind, 'meta');
  assert.match(binary.lines.at(-1).text, /^Binary files/);
});

test('an empty diff produces no sections', () => {
  assert.deepEqual(splitDiff(''), []);
  assert.deepEqual(splitDiff('\n\n'), []);
});

test('unexpected leading content is kept, not silently dropped', () => {
  const sections = splitDiff('stray warning line\ndiff --git a/x b/x\n+y\n');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].path, '');
  assert.equal(sections[0].lines[0].text, 'stray warning line');
});

test('kind words and count badges render for people, not for git', () => {
  assert.equal(kindWord('new'), 'NEW');
  assert.equal(kindWord('deleted'), 'DELETED');
  assert.equal(countBadge(12, 3, false), '+12 −3');
  assert.equal(countBadge(12, 0, false), '+12');
  assert.equal(countBadge(null, null, true), 'BINARY');
  assert.equal(countBadge(null, null, false), '');
});

// ---- generated diffs (the approval card's Edit/Write rendering) ------------

import { editDiff, writeDiff, GENERATED_DIFF_CAP } from './diff-format.ts';

test('editDiff turns shared head/tail into context and the middle into remove/add', () => {
  const oldText = ['keep one', 'old middle', 'keep two'].join('\n');
  const newText = ['keep one', 'new middle', 'extra line', 'keep two'].join('\n');
  const { text, capped } = editDiff(oldText, newText);
  assert.equal(capped, false);
  assert.deepEqual(text.split('\n'), [
    ' keep one',
    '-old middle',
    '+new middle',
    '+extra line',
    ' keep two',
  ]);
  // And splitDiff classifies exactly as the card will colour it.
  const [section] = splitDiff(text);
  assert.deepEqual(section.lines.map((l) => l.kind), ['context', 'remove', 'add', 'add', 'context']);
});

test('a context line that itself starts with + or - still reads as context', () => {
  const oldText = ['+not an add', 'change me'].join('\n');
  const newText = ['+not an add', 'changed'].join('\n');
  const [section] = splitDiff(editDiff(oldText, newText).text);
  assert.equal(section.lines[0].kind, 'context');
  assert.equal(section.lines[0].text, ' +not an add');
});

test('identical texts produce context only; a pure append produces adds only', () => {
  const same = editDiff('a\nb', 'a\nb');
  assert.ok(!same.text.split('\n').some((l) => l.startsWith('+') || l.startsWith('-')));
  const appended = editDiff('a', 'a\nb');
  assert.deepEqual(appended.text.split('\n'), [' a', '+b']);
});

test('editDiff caps long changes and says so', () => {
  const oldText = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n');
  const { text, capped } = editDiff(oldText, 'tiny');
  assert.equal(capped, true);
  assert.equal(text.split('\n').length, GENERATED_DIFF_CAP);
});

test('writeDiff renders every line as an addition and caps honestly', () => {
  const small = writeDiff('one\ntwo');
  assert.deepEqual(small.text.split('\n'), ['+one', '+two']);
  assert.equal(small.capped, false);
  const big = writeDiff(Array.from({ length: 500 }, () => 'x').join('\n'));
  assert.equal(big.capped, true);
  assert.equal(big.text.split('\n').length, GENERATED_DIFF_CAP);
});
