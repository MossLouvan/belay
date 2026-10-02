// The address race's stagger: a dead first candidate must not add noticeable
// latency before the tunnel is tried. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROBE_STAGGER_MS, raceAddresses } from './race.ts';

test('the default stagger is 75 ms', () => {
  assert.equal(PROBE_STAGGER_MS, 75);
});

test('the second candidate starts one stagger after the first, not before', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const started = [];
  const probe = async (url) => { started.push(url); return { ok: url === 'https://tunnel' }; };
  const winner = await raceAddresses(
    [{ url: 'https://lan' }, { url: 'https://tunnel' }],
    probe,
    { sleep, staggerMs: PROBE_STAGGER_MS, now: () => 0 },
  );
  assert.equal(winner?.url, 'https://tunnel');
  assert.deepEqual(slept, [PROBE_STAGGER_MS], 'the first candidate never waits; the second waits one stagger');
  assert.deepEqual(started, ['https://lan', 'https://tunnel']);
});
