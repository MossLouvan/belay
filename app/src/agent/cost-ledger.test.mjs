// Unit tests for the cost ledger: folding `result` events into per-session
// turn/cost totals, the day boundary, aggregation across sessions, and the
// words on the ledger row.
//
//   cd app && node --test src/agent/cost-ledger.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions. Only
// JSX-free modules are imported, since Node strips types but does not compile
// JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_LEDGER, combineLedgers, foldCosts, formatUsd, ledgerLine, sameLocalDay,
} from './cost-ledger.ts';

// A fixed "now": noon, local time, so day-boundary cases are unambiguous.
const NOON = new Date(2026, 8, 3, 12, 0, 0).getTime();
const YESTERDAY_NOON = new Date(2026, 8, 2, 12, 0, 0).getTime();

const result = (t, costUsd) => ({ t, kind: 'result', ok: true, ...(costUsd === undefined ? {} : { costUsd }) });

// ---- folding ----------------------------------------------------------------

test('no events folds to the empty ledger', () => {
  assert.deepEqual(foldCosts([], NOON), EMPTY_LEDGER);
});

test('sums cost and counts turns over result events', () => {
  const ledger = foldCosts([result(NOON - 3000, 0.08), result(NOON - 2000, 0.5), result(NOON - 1000, 1.34)], NOON);
  assert.equal(ledger.turns, 3);
  assert.ok(Math.abs(ledger.costUsd - 1.92) < 1e-9);
  assert.equal(ledger.todayTurns, 3);
  assert.ok(Math.abs(ledger.todayCostUsd - 1.92) < 1e-9);
});

test('only result events count — narration and tool traffic are not turns', () => {
  const ledger = foldCosts([
    { t: NOON, kind: 'user', text: 'do it' },
    { t: NOON, kind: 'text', text: 'ok' },
    { t: NOON, kind: 'tool', tool: 'Bash', callId: 'a' },
    { t: NOON, kind: 'tool-result', ok: true, callId: 'a', text: 'PASS' },
    result(NOON, 0.1),
  ], NOON);
  assert.equal(ledger.turns, 1);
  assert.ok(Math.abs(ledger.costUsd - 0.1) < 1e-9);
});

test('a result without costUsd still counts as a turn at zero cost', () => {
  const ledger = foldCosts([result(NOON), result(NOON, 0.25)], NOON);
  assert.equal(ledger.turns, 2);
  assert.ok(Math.abs(ledger.costUsd - 0.25) < 1e-9);
});

test('a garbage cost (negative) is treated as missing, not subtracted', () => {
  const ledger = foldCosts([{ t: NOON, kind: 'result', ok: true, costUsd: -3 }], NOON);
  assert.equal(ledger.turns, 1);
  assert.equal(ledger.costUsd, 0);
});

// ---- day boundary -----------------------------------------------------------

test('sameLocalDay splits at local midnight, not at a 24h offset', () => {
  const beforeMidnight = new Date(2026, 8, 2, 23, 59, 0).getTime();
  const afterMidnight = new Date(2026, 8, 3, 0, 1, 0).getTime();
  assert.equal(sameLocalDay(beforeMidnight, NOON), false);
  assert.equal(sameLocalDay(afterMidnight, NOON), true);
});

test('yesterday counts toward the total but not toward today', () => {
  const ledger = foldCosts([result(YESTERDAY_NOON, 1.0), result(NOON - 1000, 0.5)], NOON);
  assert.equal(ledger.turns, 2);
  assert.ok(Math.abs(ledger.costUsd - 1.5) < 1e-9);
  assert.equal(ledger.todayTurns, 1);
  assert.ok(Math.abs(ledger.todayCostUsd - 0.5) < 1e-9);
});

// ---- aggregation ------------------------------------------------------------

test('combineLedgers sums across sessions', () => {
  const a = foldCosts([result(NOON, 0.08)], NOON);
  const b = foldCosts([result(YESTERDAY_NOON, 1.0), result(NOON, 0.92)], NOON);
  const total = combineLedgers([a, b]);
  assert.equal(total.turns, 3);
  assert.ok(Math.abs(total.costUsd - 2.0) < 1e-9);
  assert.equal(total.todayTurns, 2);
  assert.ok(Math.abs(total.todayCostUsd - 1.0) < 1e-9);
});

test('combineLedgers of nothing is the empty ledger', () => {
  assert.deepEqual(combineLedgers([]), EMPTY_LEDGER);
});

// ---- words ------------------------------------------------------------------

test('formatUsd rounds to cents and refuses to show a tiny spend as free', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(0.08), '$0.08');
  assert.equal(formatUsd(1.925), '$1.93');
});

test('ledger line leads with today when today has activity', () => {
  const events = Array.from({ length: 14 }, (_, i) => result(NOON - i * 1000, 1.92 / 14));
  assert.equal(ledgerLine(foldCosts(events, NOON)), 'today · 14 turns · $1.92');
});

test('ledger line uses the singular for one turn', () => {
  assert.equal(ledgerLine(foldCosts([result(NOON, 0.08)], NOON)), 'today · 1 turn · $0.08');
});

test('ledger line falls back to the all-time total on a quiet day', () => {
  const ledger = foldCosts([result(YESTERDAY_NOON, 0.3), result(YESTERDAY_NOON, 0.1)], NOON);
  assert.equal(ledgerLine(ledger), 'total · 2 turns · $0.40');
});

test('ledger line omits the cost when the host never priced the turns', () => {
  assert.equal(ledgerLine(foldCosts([result(NOON), result(NOON)], NOON)), 'today · 2 turns');
});

test('ledger line is empty with no turns, so the row can hide', () => {
  assert.equal(ledgerLine(EMPTY_LEDGER), '');
});
