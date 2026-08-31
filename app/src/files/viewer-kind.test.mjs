// Unit tests for the viewer dispatch (which viewer a file opens in) and the
// fail-fast size ceilings that mirror the host's /files/raw limits. The logic
// lives in files-format.ts with the rest of the kind/category machinery.
//
//   cd app && node --test src/files/viewer-kind.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  viewerKindOf,
  isSvgName,
  previewTooLarge,
  IMAGE_PREVIEW_LIMIT,
  PDF_PREVIEW_LIMIT,
} from '../files-format.ts';

test('every supported image extension opens the image viewer', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'svg']) {
    assert.equal(viewerKindOf(`shot.${ext}`), 'image', ext);
  }
});

test('extension matching is case-insensitive — cameras write IMG_0001.HEIC', () => {
  assert.equal(viewerKindOf('IMG_0001.HEIC'), 'image');
  assert.equal(viewerKindOf('README.MD'), 'markdown');
  assert.equal(viewerKindOf('Paper.PDF'), 'pdf');
});

test('markdown gets its own viewer, other text formats do not', () => {
  assert.equal(viewerKindOf('README.md'), 'markdown');
  assert.equal(viewerKindOf('notes.markdown'), 'markdown');
  assert.equal(viewerKindOf('notes.txt'), 'text');
  assert.equal(viewerKindOf('config.yaml'), 'text');
});

test('pdf opens the document viewer', () => {
  assert.equal(viewerKindOf('paper.pdf'), 'pdf');
});

test('source code stays in the text viewer', () => {
  assert.equal(viewerKindOf('index.ts'), 'text');
  assert.equal(viewerKindOf('main.rs'), 'text');
});

test('known binary formats are refused up front, before any bytes move', () => {
  for (const name of ['app.zip', 'movie.mp4', 'song.mp3', 'tool.exe', 'lib.dylib', 'sheet.xlsx', 'deck.pptx']) {
    assert.equal(viewerKindOf(name), 'binary', name);
  }
});

test('an unknown extension falls through to text — looksBinary catches the rest', () => {
  assert.equal(viewerKindOf('Makefile'), 'text');
  assert.equal(viewerKindOf('weird.xyz'), 'text');
});

test('a dotfile has no extension — .png the dotfile is not an image', () => {
  assert.equal(viewerKindOf('.png'), 'text');
});

test('isSvgName separates svg from raster, since only raster can use <Image>', () => {
  assert.ok(isSvgName('logo.svg'));
  assert.ok(isSvgName('LOGO.SVG'));
  assert.ok(!isSvgName('logo.png'));
});

test('previewTooLarge mirrors the host ceilings and names both sizes', () => {
  assert.equal(previewTooLarge('image', 1024), null);
  assert.equal(previewTooLarge('pdf', PDF_PREVIEW_LIMIT), null);
  const overImage = previewTooLarge('image', IMAGE_PREVIEW_LIMIT + 1);
  assert.match(String(overImage), /25\.0 MB/);
  const overPdf = previewTooLarge('pdf', 200 * 1024 * 1024);
  assert.match(String(overPdf), /200\.0 MB/);
  assert.match(String(overPdf), /50\.0 MB/);
});

test('previewTooLarge only applies to the fetched-whole kinds', () => {
  assert.equal(previewTooLarge('text', Number.MAX_SAFE_INTEGER), null);
  assert.equal(previewTooLarge('binary', Number.MAX_SAFE_INTEGER), null);
});
