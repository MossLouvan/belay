// Unit tests for the Files screen's pure formatting helpers.
//
//   cd app && node --test src/files-format.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryOf,
  crumbsFor,
  defaultDescending,
  extensionOf,
  formatSize,
  formatAsOf,
  formatWhen,
  isDenied,
  kindOf,
  looksBinary,
  parentOf,
  sortEntries,
  toMillis,
} from './files-format.ts';

const fileEntry = (name, over = {}) => ({ name, path: `/x/${name}`, dir: false, size: 0, mtime: 0, ...over });
const names = (entries) => entries.map((e) => e.name);

// --- breadcrumbs -------------------------------------------------------------

test('a POSIX path splits into crumbs that each resolve to a real ancestor', () => {
  const crumbs = crumbsFor('/Users/moss/Documents');
  assert.deepEqual(crumbs, [
    { label: '/', path: '/' },
    { label: 'Users', path: '/Users' },
    { label: 'moss', path: '/Users/moss' },
    { label: 'Documents', path: '/Users/moss/Documents' },
  ]);
});

test('a Windows path keeps the drive tappable, with its trailing backslash', () => {
  const crumbs = crumbsFor('C:\\Users\\moss');
  assert.deepEqual(crumbs, [
    { label: 'C:', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'moss', path: 'C:\\Users\\moss' },
  ]);
});

test('the filesystem root is one crumb, and an empty path is none', () => {
  assert.deepEqual(crumbsFor('/'), [{ label: '/', path: '/' }]);
  assert.deepEqual(crumbsFor(''), []);
});

test('parentOf walks one level up and stops at the top', () => {
  assert.equal(parentOf('/Users/moss'), '/Users');
  assert.equal(parentOf('/Users'), '/');
  assert.equal(parentOf('/'), null, 'the root has no parent to offer');
  assert.equal(parentOf('C:\\Users'), 'C:\\');
});

// --- sizes and dates ---------------------------------------------------------

test('sizes step through the units without pretending precision', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(2048), '2 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(3 * 1024 * 1024 * 1024), '3.0 GB');
  assert.equal(formatSize(-1), '—', 'a nonsense size renders as absence, not garbage');
});

test('toMillis accepts both the second- and millisecond-reporting hosts', () => {
  assert.equal(toMillis(1700000000), 1700000000000, 'seconds get promoted');
  assert.equal(toMillis(1700000000000), 1700000000000, 'milliseconds pass through');
  assert.equal(toMillis(0), 0);
  assert.equal(toMillis(NaN), 0);
});

test('recent timestamps read as relative, and a missing one as nothing', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatWhen(now - 30_000, now), 'just now');
  assert.equal(formatWhen(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatWhen(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatWhen(now - 2 * 86_400_000, now), '2d ago');
  assert.equal(formatWhen(0, now), '');
});

test('the header freshness stamp is a zero-padded local HH:MM, empty when unknown', () => {
  const at = new Date(2026, 7, 31, 9, 5).getTime();
  assert.equal(formatAsOf(at), 'as of 09:05');
  const late = new Date(2026, 7, 31, 14, 2).getTime();
  assert.equal(formatAsOf(late), 'as of 14:02');
  assert.equal(formatAsOf(0), '');
  assert.equal(formatAsOf(Number.NaN), '');
});

// --- categories --------------------------------------------------------------

test('extensions resolve case-blind, and dotfiles are not all extension', () => {
  assert.equal(extensionOf('PHOTO.PNG'), 'png');
  assert.equal(extensionOf('.gitignore'), '', 'a leading dot is a hidden-file marker, not a separator');
  assert.equal(extensionOf('no-extension'), '');
});

test('categoryOf answers folder for directories regardless of name', () => {
  assert.equal(categoryOf({ name: 'x.zip', path: '/x.zip', dir: true, size: 0, mtime: 0 }), 'folder');
  assert.equal(categoryOf({ name: 'x.zip', path: '/x.zip', dir: false, size: 0, mtime: 0 }), 'archive');
});

// --- kind labels -------------------------------------------------------------

test('a directory is simply a Folder, whatever its name looks like', () => {
  assert.equal(kindOf(fileEntry('archive.zip', { dir: true })), 'Folder');
});

test('known extensions read as plain English, the way Finder prints them', () => {
  assert.equal(kindOf(fileEntry('photo.png')), 'PNG image');
  assert.equal(kindOf(fileEntry('index.ts')), 'TS source');
  assert.equal(kindOf(fileEntry('notes.md')), 'MD text');
  assert.equal(kindOf(fileEntry('backup.zip')), 'ZIP archive');
  assert.equal(kindOf(fileEntry('report.pdf')), 'PDF document');
});

test('audio and video split even though they share one colour category', () => {
  assert.equal(kindOf(fileEntry('song.mp3')), 'MP3 audio');
  assert.equal(kindOf(fileEntry('clip.mov')), 'MOV movie');
});

test('an unknown extension still gets an honest label, and no extension is a Document', () => {
  assert.equal(kindOf(fileEntry('data.xyz')), 'XYZ file');
  assert.equal(kindOf(fileEntry('Makefile')), 'Document');
  assert.equal(kindOf(fileEntry('.gitignore')), 'Document');
});

// --- sorting -----------------------------------------------------------------
// The basic name/size cases live in screen-helpers.test.mjs; these cover what
// the Finder rebuild added — the kind key, tie-breaks, and default directions.

test('folders lead under every key and both directions', () => {
  const mixed = [
    fileEntry('zz.txt', { size: 9 }),
    fileEntry('Apps', { dir: true }),
    fileEntry('aa.txt', { size: 1 }),
    fileEntry('Books', { dir: true }),
  ];
  for (const key of ['name', 'kind', 'size', 'date']) {
    for (const descending of [false, true]) {
      const sorted = sortEntries(mixed, key, descending);
      assert.deepEqual(
        sorted.slice(0, 2).map((e) => e.dir),
        [true, true],
        `folders must lead for ${key} ${descending ? 'desc' : 'asc'}`
      );
    }
  }
});

test('name sort is case-blind and numeric-aware, so file2 sits before file10', () => {
  const sorted = sortEntries([fileEntry('file10.txt'), fileEntry('File2.txt'), fileEntry('apple.txt')], 'name', false);
  assert.deepEqual(names(sorted), ['apple.txt', 'File2.txt', 'file10.txt']);
});

test('kind sort groups files of a type together, names breaking ties', () => {
  const sorted = sortEntries([fileEntry('z.png'), fileEntry('a.ts'), fileEntry('m.png'), fileEntry('b.zip')], 'kind', false);
  // Ascending by label: "PNG image" < "TS source" < "ZIP archive".
  assert.deepEqual(names(sorted), ['m.png', 'z.png', 'a.ts', 'b.zip']);
});

test('equal sizes fall back to name order instead of platform-dependent shuffle', () => {
  const sorted = sortEntries([fileEntry('b.bin', { size: 5 }), fileEntry('a.bin', { size: 5 })], 'size', true);
  assert.deepEqual(names(sorted), ['a.bin', 'b.bin']);
});

test('date sort survives hosts that report seconds instead of milliseconds', () => {
  // 1700000000 (seconds) is newer than 1600000000000 (ms) once normalised;
  // compared raw it would look absurdly older.
  const sorted = sortEntries(
    [fileEntry('old.txt', { mtime: 1600000000000 }), fileEntry('new.txt', { mtime: 1700000000 })],
    'date',
    true
  );
  assert.deepEqual(names(sorted), ['new.txt', 'old.txt']);
});

test('sorting returns a new array and leaves the input in server order', () => {
  const input = Object.freeze([fileEntry('b.txt'), fileEntry('a.txt')]);
  const sorted = sortEntries(input, 'name', false);
  assert.notEqual(sorted, input);
  assert.deepEqual(names(input), ['b.txt', 'a.txt']);
});

test('fresh columns start in the direction people expect of them', () => {
  assert.equal(defaultDescending('name'), false);
  assert.equal(defaultDescending('kind'), false);
  assert.equal(defaultDescending('size'), true, 'you sort by size to find the big ones');
  assert.equal(defaultDescending('date'), true, 'you sort by date to find the new ones');
});

// --- binary heuristic and errors ---------------------------------------------

test('a NUL byte is an immediate binary verdict', () => {
  assert.equal(looksBinary('hello\u0000world'), true);
});

test('an ANSI-coloured log stays readable — the regression that motivated the ESC rule', () => {
  const log = '\u001b[32mPASS\u001b[0m test one\n'.repeat(50);
  assert.equal(looksBinary(log), false);
});

test('the messages a host refusal produces are recognised as denials', () => {
  assert.equal(isDenied('path is outside the allowed roots'), true, 'the host allow-list refusal, verbatim');
  assert.equal(isDenied('EACCES: permission denied'), true);
  assert.equal(isDenied('path does not exist'), false, 'a typo is not a refusal');
});
