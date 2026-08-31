// Unit tests for the markdown block/inline parser behind the rendered view.
//
//   cd app && node --test src/files/markdown.test.mjs
//
// The cases lean on what real READMEs contain: fenced code with a language,
// nested emphasis, task-adjacent lists, and the pathological inputs (unclosed
// fence, stray asterisks) that must degrade to visible text, never vanish.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown, parseInline } from './markdown.ts';

const textOf = (spans) => spans.map((s) => s.text).join('');

// ---- blocks ----------------------------------------------------------------

test('headings map # count to level and parse their inline content', () => {
  const blocks = parseMarkdown('# Title\n\n### Sub **bold**');
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[0].level, 1);
  assert.equal(textOf(blocks[0].spans), 'Title');
  assert.equal(blocks[1].level, 3);
  assert.ok(blocks[1].spans.some((s) => s.bold && s.text === 'bold'));
});

test('consecutive lines join into one paragraph; a blank line splits them', () => {
  const blocks = parseMarkdown('one\ntwo\n\nthree');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'paragraph');
  assert.equal(textOf(blocks[0].spans), 'one two');
  assert.equal(textOf(blocks[1].spans), 'three');
});

test('a fenced block keeps its language and its raw text, inline markup and all', () => {
  const blocks = parseMarkdown('```ts\nconst a = **not bold**;\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].lang, 'ts');
  assert.equal(blocks[0].text, 'const a = **not bold**;');
});

test('an unclosed fence swallows to the end rather than erroring', () => {
  const blocks = parseMarkdown('```\nline1\nline2');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].text, 'line1\nline2');
});

test('unordered and ordered items carry their marker and depth', () => {
  const blocks = parseMarkdown('- a\n  - nested\n1. one\n2) two');
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.ordered, b.depth]),
    [['item', false, 0], ['item', false, 1], ['item', true, 0], ['item', true, 0]],
  );
  assert.equal(blocks[2].marker, '1.');
  assert.equal(textOf(blocks[1].spans), 'nested');
});

test('blockquote lines become quote blocks', () => {
  const blocks = parseMarkdown('> wisdom\n> more');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'quote');
  assert.equal(textOf(blocks[0].spans), 'wisdom');
});

test('a horizontal rule is recognised in all three spellings', () => {
  for (const rule of ['---', '***', '___', '- - -']) {
    const blocks = parseMarkdown(rule);
    assert.equal(blocks[0].kind, 'rule', rule);
  }
});

test('a lone dash line is a paragraph, not a rule', () => {
  assert.equal(parseMarkdown('-')[0].kind, 'paragraph');
});

test('empty input parses to no blocks', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('\n\n\n'), []);
});

// ---- inline ----------------------------------------------------------------

test('bold, italic and code each mark their span', () => {
  const spans = parseInline('a **b** *c* `d` e');
  assert.deepEqual(
    spans.map((s) => [s.text, !!s.bold, !!s.italic, !!s.code]),
    [['a ', false, false, false], ['b', true, false, false], [' ', false, false, false],
     ['c', false, true, false], [' ', false, false, false], ['d', false, false, true],
     [' e', false, false, false]],
  );
});

test('italic nests inside bold', () => {
  const spans = parseInline('**bold *and italic***');
  assert.ok(spans.some((s) => s.bold && s.italic && s.text === 'and italic'));
  assert.ok(spans.some((s) => s.bold && !s.italic && s.text === 'bold '));
});

test('code spans are literal — no emphasis inside backticks', () => {
  const spans = parseInline('`**raw**`');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, '**raw**');
  assert.ok(spans[0].code && !spans[0].bold);
});

test('links keep their text and carry the url', () => {
  const spans = parseInline('see [the docs](https://example.com) here');
  const link = spans.find((s) => s.link);
  assert.equal(link.text, 'the docs');
  assert.equal(link.link, 'https://example.com');
});

test('underscore emphasis works too', () => {
  assert.ok(parseInline('__b__').some((s) => s.bold && s.text === 'b'));
  assert.ok(parseInline('_i_').some((s) => s.italic && s.text === 'i'));
});

test('a stray asterisk renders as itself instead of eating the line', () => {
  assert.equal(textOf(parseInline('2 * 3 = 6')), '2 * 3 = 6');
  assert.equal(textOf(parseInline('a ** b')), 'a ** b');
});

test('plain text passes through as a single span', () => {
  const spans = parseInline('nothing fancy here');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, 'nothing fancy here');
});
