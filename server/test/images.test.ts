// The image drop is the second write surface into the file API, and it takes
// bytes straight off the network — so these tests are about the gates: only
// real image bytes get in, every cap actually refuses, delivery is confined
// to the allow-list roots, and no client-supplied string ever names a file.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { ImageDrop, IMAGE_DIR_PATTERN, buildImagesPrompt, sniffImageType } from '../src/images.js';
import { pruneRecordings } from '../src/recording.js';

// Same sandbox pattern as recording.test.ts: the project lives under $HOME so
// it is inside the allow-list roots; the escape target lives in the real
// tmpdir, outside every root.
let project = '';
let outside = '';

before(async () => {
  project = join(homedir(), '.belay-test-images');
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  outside = await mkdtemp(join(tmpdir(), 'belay-img-outside-'));
});

after(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const pad = (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.alloc(64)]);

const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const PNG = pad(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n', 'latin1')]));
const GIF = pad(Buffer.from('GIF89a', 'latin1'));
const WEBP = pad(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]));
const HEIC = pad(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'latin1')]));

test('sniffing recognises the five accepted formats and nothing else', () => {
  assert.equal(sniffImageType(JPEG), 'jpg');
  assert.equal(sniffImageType(PNG), 'png');
  assert.equal(sniffImageType(GIF), 'gif');
  assert.equal(sniffImageType(WEBP), 'webp');
  assert.equal(sniffImageType(HEIC), 'heic');
  // The dangerous impostors: markup and scripts dressed as images.
  assert.equal(sniffImageType(pad(Buffer.from('<svg xmlns="…">', 'latin1'))), null);
  assert.equal(sniffImageType(pad(Buffer.from('<!DOCTYPE html><script>', 'latin1'))), null);
  assert.equal(sniffImageType(pad(Buffer.from('#!/bin/sh\nrm -rf', 'latin1'))), null);
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8])), null); // too short to judge
});

test('add refuses empties, non-images and every cap', () => {
  const drop = new ImageDrop({ maxImages: 2, maxImageBytes: 256, maxTotalBytes: 300 });
  assert.throws(() => drop.add(Buffer.alloc(0)), /empty/);
  assert.throws(() => drop.add(pad(Buffer.from('plain text', 'latin1'))), /not a supported image/);
  assert.throws(() => drop.add(Buffer.concat([JPEG, Buffer.alloc(512)])), /too large/);

  assert.equal(drop.add(JPEG).images, 1);
  assert.throws(() => drop.add(Buffer.concat([PNG, Buffer.alloc(170)])), /together are too large/);
  assert.equal(drop.add(PNG).images, 2);
  assert.throws(() => drop.add(GIF), /at most 2 images/);
});

test('an abandoned batch expires instead of riding along in the next send', () => {
  let clock = 1_000_000;
  const drop = new ImageDrop({ staleAfterMs: 500, now: () => clock });
  drop.add(JPEG);
  clock += 600;
  assert.equal(drop.status().images, 0);
  // A fresh add after expiry starts a clean batch.
  assert.equal(drop.add(PNG).images, 1);
});

test('discard clears the batch and leaves zero bytes anywhere', async () => {
  const drop = new ImageDrop();
  drop.add(JPEG);
  const status = drop.discard();
  assert.equal(status.images, 0);
  assert.equal(status.bytes, 0);
  await assert.rejects(() => drop.deliver(project), /no images to send/);
});

test('deliver writes server-named files in pick order and resets', async () => {
  const drop = new ImageDrop();
  drop.add(JPEG);
  drop.add(HEIC);
  drop.add(PNG);
  const delivery = await drop.deliver(project, 'compare before and after');

  // Names are minted here — pick order, sniffed extension, no client input.
  assert.deepEqual(delivery.files, ['photo-01.jpg', 'photo-02.heic', 'photo-03.png']);
  assert.match(delivery.relDir, /^\.belay[\\/]images[\\/]img-\d{8}-\d{6}$/);
  assert.match(delivery.prompt, /compare before and after/);
  assert.match(delivery.prompt, /photo-01\.jpg, photo-02\.heic, photo-03\.png/);
  assert.match(delivery.prompt, /do not commit/);

  const written = (await readdir(delivery.dir)).sort();
  assert.deepEqual(written, [...delivery.files].sort());
  assert.equal(drop.status().images, 0);
  await assert.rejects(() => drop.deliver(project), /no images to send/);
});

test('deliver refuses a project outside the allowed roots and keeps nothing there', async () => {
  const drop = new ImageDrop();
  drop.add(JPEG);
  await assert.rejects(() => drop.deliver(outside), /outside the allowed folders/);
  assert.equal(existsSync(join(outside, '.belay')), false);
  drop.discard();
});

test('the default prompt asks for a description when there is no note', () => {
  const prompt = buildImagesPrompt({ relDir: '.belay/images/img-x', fileNames: ['photo-01.jpg'] });
  assert.match(prompt, /1 photo from my phone/);
  assert.match(prompt, /describe what each photo shows/);
});

test('pruning image drops keeps the newest maxSaved and ignores recordings-style names', async () => {
  const imagesDir = join(project, '.belay', 'images');
  await rm(imagesDir, { recursive: true, force: true });
  await mkdir(imagesDir, { recursive: true });
  const names = [
    'img-20260825-090000', 'img-20260826-090000', 'img-20260827-090000',
    'img-20260828-090000', 'img-20260829-090000', 'img-20260830-090000',
  ];
  for (const name of names) await mkdir(join(imagesDir, name));
  await mkdir(join(imagesDir, 'rec-20260830-090000'));
  await writeFile(join(imagesDir, 'keep-me.txt'), 'not an image drop\n', 'utf8');

  await pruneRecordings(imagesDir, 5, IMAGE_DIR_PATTERN);
  const left = (await readdir(imagesDir)).sort();
  assert.deepEqual(left, ['keep-me.txt', ...names.slice(1), 'rec-20260830-090000'].sort());
});
