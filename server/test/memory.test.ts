// Unit tests for the macOS `vm_stat` parser (#67). Pure string -> bytes, so
// it runs identically on every platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVmStat } from '../src/memory.js';

const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
  'Pages free:                              119956.',
  'Pages active:                           1411005.',
  'Pages inactive:                         1404451.',
  'Pages speculative:                        12345.',
  'Pages throttled:                              0.',
  'Pages wired down:                        862960.',
  'Pages purgeable:                          54321.',
  '"Translation faults":                 123456789.',
  'Pages occupied by compressor:            100000.',
  'Pages stored in compressor:              300000.',
].join('\n');

test('parseVmStat counts active + wired + compressor pages as used', () => {
  const used = parseVmStat(VM_STAT);
  assert.equal(used, (1411005 + 862960 + 100000) * 4096);
});

test('parseVmStat honours the page size the header reports', () => {
  const used = parseVmStat(VM_STAT.replace('page size of 4096', 'page size of 16384'));
  assert.equal(used, (1411005 + 862960 + 100000) * 16384);
});

test('parseVmStat returns null on unexpected output', () => {
  assert.equal(parseVmStat(''), null);
  assert.equal(parseVmStat('vm_stat: command not found'), null);
  // No page size line -> cannot turn pages into bytes.
  assert.equal(parseVmStat('Pages active: 10.\nPages wired down: 10.'), null);
});
