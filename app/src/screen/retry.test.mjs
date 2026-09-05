// Unit tests for the reconnect panel's elapsed-time phrasing and the
// probe-gate decision (backlog item `retry-honesty`).
//
//   cd app && node --test src/screen/retry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FRESH_OUTAGE_MS, PROBE_INTERVAL_MS, retryPhrase, shouldProbeDuringBackoff } from './retry.ts';

// --- retryPhrase ------------------------------------------------------------

test('a fresh outage just says reconnecting — no confession yet', () => {
  const since = 100_000;
  assert.equal(retryPhrase(since, since), 'Reconnecting…');
  assert.equal(retryPhrase(since + FRESH_OUTAGE_MS - 1, since), 'Reconnecting…');
});

test('past the fresh window it owns up in seconds', () => {
  const since = 100_000;
  assert.equal(retryPhrase(since + FRESH_OUTAGE_MS, since), 'Still trying · 10s');
  assert.equal(retryPhrase(since + 42_000, since), 'Still trying · 42s');
  assert.equal(retryPhrase(since + 59_999, since), 'Still trying · 59s');
});

test('whole minutes once a minute has passed — never "ATTEMPT 86"', () => {
  const since = 0;
  assert.equal(retryPhrase(60_000, since), 'Still trying · 1m');
  assert.equal(retryPhrase(9 * 60_000 + 30_000, since), 'Still trying · 9m');
  assert.equal(retryPhrase(59 * 60_000 + 59_000, since), 'Still trying · 59m');
});

test('hours read as h + m, dropping a zero-minute remainder', () => {
  const since = 0;
  assert.equal(retryPhrase(60 * 60_000, since), 'Still trying · 1h');
  assert.equal(retryPhrase(72 * 60_000, since), 'Still trying · 1h 12m');
  assert.equal(retryPhrase(2 * 60 * 60_000 + 60_000, since), 'Still trying · 2h 1m');
});

test('a clock that runs backwards (resync, bad since) clamps to fresh', () => {
  assert.equal(retryPhrase(1000, 5000), 'Reconnecting…');
});

// --- shouldProbeDuringBackoff ----------------------------------------------

test('short waits are not worth probing — the retry itself is imminent', () => {
  assert.equal(shouldProbeDuringBackoff(0), false);
  assert.equal(shouldProbeDuringBackoff(PROBE_INTERVAL_MS), false);
});

test('waits longer than one probe cycle get the health probe', () => {
  assert.equal(shouldProbeDuringBackoff(PROBE_INTERVAL_MS + 1), true);
  assert.equal(shouldProbeDuringBackoff(15_000), true);
});

test('nonsense delays never arm a probe', () => {
  assert.equal(shouldProbeDuringBackoff(-1), false);
  assert.equal(shouldProbeDuringBackoff(Number.NaN), false);
});
