// Unit tests for the tool-drawer model.
//
//   cd app && node --test src/home/tools.test.mjs
//
// Same shape as the other suites: no framework, JSX-free modules only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, toolBadge, toolRows } from './tools.ts';

test('the drawer lists exactly the four moved tabs, agent first', () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.id),
    ['agent', 'terminal', 'files', 'system'],
  );
});

test('every tool routes to its own panel inside the home stack', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.route, `/${tool.id}`);
  }
  assert.equal(new Set(TOOLS.map((tool) => tool.route)).size, TOOLS.length);
});

test('every tool explains itself in one novice-readable line', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.title.length >= 4 && tool.title.length <= 12, `${tool.id} title`);
    assert.ok(tool.description.length >= 20, `${tool.id} description too thin to help`);
    assert.ok(tool.description.length <= 70, `${tool.id} description will wrap into a paragraph`);
    assert.ok(!tool.description.endsWith('.'), `${tool.id} description is a caption, not a sentence`);
  }
});

test('only the agent carries a count, and only when someone is waiting', () => {
  assert.equal(toolBadge('agent', 2), 2);
  assert.equal(toolBadge('agent', 0), null);
  assert.equal(toolBadge('agent', -1), null);
  assert.equal(toolBadge('terminal', 3), null);
  assert.equal(toolBadge('files', 1), null);
  assert.equal(toolBadge('system', 1), null);
});

test('toolRows chunks the real list two to a row', () => {
  const rows = toolRows(TOOLS);
  assert.equal(rows.length, Math.ceil(TOOLS.length / 2));
  assert.deepEqual(rows.flat().map((t) => t.id), TOOLS.map((t) => t.id));
  rows.forEach((row) => assert.ok(row.length >= 1 && row.length <= 2));
});

test('toolRows keeps an odd tool in a row of its own rather than dropping it', () => {
  const five = [...TOOLS, { id: 'agent', title: 'x', description: 'y', route: '/agent' }];
  const rows = toolRows(five);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].length, 1);
  assert.equal(rows.flat().length, five.length);
});

test('toolRows never mutates the list it is given', () => {
  const before = TOOLS.map((t) => t.id);
  toolRows(TOOLS);
  assert.deepEqual(TOOLS.map((t) => t.id), before);
});

test('toolRows honours a different row width and rejects a nonsense one', () => {
  assert.equal(toolRows(TOOLS, 4).length, 1);
  assert.equal(toolRows(TOOLS, 1).length, TOOLS.length);
  assert.throws(() => toolRows(TOOLS, 0), /at least 1/);
});
