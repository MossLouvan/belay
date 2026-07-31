// Unit tests for the disk-usage parsers. These are pure string -> numbers
// functions, so they run identically on every platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDf, parsePowerShellDisk, diskTarget } from '../src/disk.js';

const KIB = 1024;

test('parseDf reads a macOS APFS data volume line', () => {
  const out = [
    'Filesystem   1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s5   482797652 375406176  66002164    86%    /System/Volumes/Data',
  ].join('\n');
  const info = parseDf(out);
  assert.ok(info);
  assert.equal(info.total, 482797652 * KIB);
  assert.equal(info.free, 66002164 * KIB);
  // df's own capacity column wins over (total-free)/total, which differs on
  // APFS because of snapshots and purgeable space.
  assert.equal(info.percent, 86);
});

test('parseDf reads a Linux-style line', () => {
  const out = [
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/nvme0n1p2   100000000 40000000  55000000      43% /',
  ].join('\n');
  const info = parseDf(out);
  assert.ok(info);
  assert.equal(info.total, 100000000 * KIB);
  assert.equal(info.free, 55000000 * KIB);
  assert.equal(info.percent, 43);
});

test('parseDf tolerates spaces in the filesystem and mount point names', () => {
  const out = [
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    'map auto home   1000   250   750    25%    /Volumes/My External Disk',
  ].join('\n');
  const info = parseDf(out);
  assert.ok(info);
  assert.equal(info.total, 1000 * KIB);
  assert.equal(info.free, 750 * KIB);
  assert.equal(info.percent, 25);
});

test('parseDf ignores trailing blank lines and CRLF', () => {
  const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\r\n/dev/x 200 50 150 25% /\r\n\r\n';
  const info = parseDf(out);
  assert.ok(info);
  assert.equal(info.total, 200 * KIB);
});

test('parseDf returns null on garbage, empty output, or a header only', () => {
  assert.equal(parseDf(''), null);
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on'), null);
  assert.equal(parseDf('df: /nope: No such file or directory'), null);
});

test('parseDf rejects a zero-block filesystem rather than dividing by zero', () => {
  const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmap -hosts 0 0 0 100% /net';
  assert.equal(parseDf(out), null);
});

test('parsePowerShellDisk reads the two-line total/free output', () => {
  const info = parsePowerShellDisk('1000000\r\n250000\r\n');
  assert.ok(info);
  assert.equal(info.total, 1000000);
  assert.equal(info.free, 250000);
  assert.equal(info.percent, 75);
});

test('parsePowerShellDisk returns null on incomplete or non-numeric output', () => {
  assert.equal(parsePowerShellDisk('1000000'), null);
  assert.equal(parsePowerShellDisk('nope\nnope'), null);
  assert.equal(parsePowerShellDisk('0\n0'), null);
});

test('diskTarget picks the root volume on non-darwin platforms', () => {
  assert.equal(diskTarget('win32'), '/');
  assert.equal(diskTarget('linux'), '/');
});
