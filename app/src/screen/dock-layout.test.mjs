import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDockKeys } from './dock-layout.ts';

const gap = 8;

// Reconstruct the rows Yoga's flex-wrap sees, checking the actual allocated
// widths rather than just the partitioner's desired line breaks.
function rowsOf(cells, available) {
  const rows = [];
  let used = 0;
  for (const cell of cells) {
    if (!rows.length || used + gap + cell > available) {
      rows.push([]);
      used = 0;
    }
    used += (rows.at(-1).length ? gap : 0) + cell;
    rows.at(-1).push(cell);
  }
  return rows;
}

function checkLayout(widths, available) {
  const before = [...widths];
  const cells = layoutDockKeys(widths, available, gap);
  assert.deepEqual(widths, before, 'measurements are immutable');
  assert.equal(cells.length, widths.length, 'every key keeps its slot and reading order');
  cells.forEach((cell, index) => assert.ok(cell >= widths[index], 'no key shrinks'));
  const rows = rowsOf(cells, available);
  for (const row of rows) {
    const used = row.reduce((sum, cell) => sum + cell, 0) + gap * (row.length - 1);
    assert.ok(used <= available, 'no overlap or overflow');
    assert.ok(available - used < 0.01, 'each bank fills the width, including the last');
  }
  return rows.map((row) => row.length);
}

for (const phone of [375, 390]) {
  for (const floating of [false, true]) {
    test(`${phone}pt ${floating ? 'HUD' : 'docked'}: optional keys and recorder phases balance`, () => {
      // Representative intrinsic widths of the 11pt tracked mono keys,
      // including 8pt padding and the 44pt minimum target. Runtime uses
      // native measurements, not these font-width fixtures.
      const available = phone - (floating ? 24 + 16 + 1 : 40);
      for (const clipboard of [false, true]) {
        for (const monitor of [false, true]) {
          for (const navigation of [false, true]) {
            for (const record of [44, 45, 46]) {
              const widths = [
                ...(floating && navigation ? [57] : []), // Back
                65, 65, record,
                ...(clipboard ? [81] : []),
                44,
                ...(floating && navigation ? [44] : []), // Menu
                ...(monitor ? [65] : []),
                65, // Tools
              ];
              const counts = checkLayout(widths, available);
              const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
              assert.equal(counts.length, total <= available ? 1 : 2);
              assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${counts}`);
            }
          }
        }
      }
    });

    test(`${phone}pt ${floating ? 'HUD' : 'docked'}: larger type and long monitor labels fit`, () => {
      const available = phone - (floating ? 41 : 40);
      for (const scale of [1, 1.15, 1.3]) {
        const widths = [
          ...(floating ? [57] : []), 65, 65, 46, 81, 44,
          ...(floating ? [44] : []), 90, 65,
        ].map((width) => Math.ceil(width * scale));
        const counts = checkLayout(widths, available);
        assert.ok(counts.length <= 3);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
      }
    });
  }
}

test('balanced banks avoid the greedy five-plus-one orphan', () => {
  assert.deepEqual(checkLayout([44, 44, 44, 44, 44, 44], 260), [3, 3]);
});

test('wide landscape uses one bank when all keys fit', () => {
  assert.deepEqual(checkLayout([57, 65, 65, 44, 81, 44, 44, 65, 65], 760), [9]);
});

test('fractional widths and exact fits do not wrap the last key accidentally', () => {
  assert.deepEqual(checkLayout([65.25, 81.5, 44.25], 207), [3]);
  assert.deepEqual(checkLayout([65.25, 81.5, 44.25, 65.125, 44], 207.333), [2, 3]);
});

test('empty, single and exceptionally wide keys preserve their natural width', () => {
  assert.deepEqual(layoutDockKeys([], 335, gap), []);
  assert.deepEqual(layoutDockKeys([81], 335, gap), [335]);
  assert.deepEqual(layoutDockKeys([400, 44], 335, gap), [400, 335]);
});
