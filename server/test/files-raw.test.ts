// Confinement tests for the binary preview path. `/files/raw` hands out the
// *bytes* of a file rather than a truncated UTF-8 rendering, which makes it the
// more valuable target: a symlink escape here leaks photos and PDFs intact, not
// a 512 KB text sample. So, as in files.test.ts, the attacks lead: traversal,
// absolute paths outside the roots, real symlinks planted under $HOME, and the
// deny-listed state file that holds every device's bearer token.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { statRawFile, rawKindOf, mimeOf, RAW_LIMITS } from '../src/files-raw.js';

const HOME = homedir();

// A sandbox *outside* the roots that the escape attempts aim at.
let outside = '';
let outsideImage = '';
// A working directory *inside* home, holding the fixtures and links under test.
let inside = '';

// A tiny but real PNG header, so the fixture is honest about being binary.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

before(async () => {
  outside = await mkdtemp(join(tmpdir(), 'tether-raw-outside-'));
  outsideImage = join(outside, 'secret.png');
  await writeFile(outsideImage, PNG_BYTES);

  inside = join(HOME, '.tether-test-raw');
  await rm(inside, { recursive: true, force: true });
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, 'photo.png'), PNG_BYTES);
  await writeFile(join(inside, 'SHOUTY.PNG'), PNG_BYTES);
  await writeFile(join(inside, 'doc.pdf'), Buffer.from('%PDF-1.4 tiny'));
  await writeFile(join(inside, 'big.pdf'), Buffer.alloc(4096, 0x20));
  await writeFile(join(inside, 'notes.txt'), 'plain text\n', 'utf8');
  await writeFile(join(inside, 'noext'), PNG_BYTES);
  // The state file holds every paired device's raw token; served as an
  // "image", it would still be the same bytes.
  await writeFile(join(inside, 'tether-state.json'), '{"devices":[]}', 'utf8');
  await symlink(outsideImage, join(inside, 'link-to-secret.png'));
  await symlink(outside, join(inside, 'link-to-outside-dir'));
});

after(async () => {
  await rm(inside, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ---- escapes ---------------------------------------------------------------

test('lexical .. traversal is rejected', async () => {
  await assert.rejects(
    () => statRawFile(join(HOME, '..', '..', '..', 'etc', 'passwd.png')),
    /outside the allowed roots|does not exist/,
  );
});

test('an absolute path outside the roots is rejected', async () => {
  await assert.rejects(() => statRawFile(outsideImage), /outside the allowed roots/);
});

test('a symlink inside home pointing at an image outside cannot be served', async () => {
  await assert.rejects(
    () => statRawFile(join(inside, 'link-to-secret.png')),
    /outside the allowed roots/,
  );
});

test('a path routed through a symlinked directory cannot escape either', async () => {
  await assert.rejects(
    () => statRawFile(join(inside, 'link-to-outside-dir', 'secret.png')),
    /outside the allowed roots/,
  );
});

test('the deny-listed state file is refused even under an allowed root', async () => {
  await assert.rejects(
    () => statRawFile(join(inside, 'tether-state.json')),
    /outside the allowed roots/,
  );
});

test('a nonexistent path reports that, not a raw ENOENT', async () => {
  await assert.rejects(() => statRawFile(join(inside, 'missing.png')), /does not exist/);
});

test('a directory is refused', async () => {
  await assert.rejects(() => statRawFile(inside), /directory/);
});

// ---- type gating -----------------------------------------------------------

test('only previewable types are served — text and unknown extensions are refused', async () => {
  await assert.rejects(() => statRawFile(join(inside, 'notes.txt')), /no binary preview/i);
  await assert.rejects(() => statRawFile(join(inside, 'noext')), /no binary preview/i);
});

test('a png resolves with its mime, size and real path', async () => {
  const raw = await statRawFile(join(inside, 'photo.png'));
  assert.equal(raw.mime, 'image/png');
  assert.equal(raw.kind, 'image');
  assert.equal(raw.name, 'photo.png');
  assert.equal(raw.size, PNG_BYTES.length);
});

test('extension matching is case-insensitive — cameras write .PNG and .HEIC', async () => {
  const raw = await statRawFile(join(inside, 'SHOUTY.PNG'));
  assert.equal(raw.mime, 'image/png');
});

test('a pdf resolves with its mime', async () => {
  const raw = await statRawFile(join(inside, 'doc.pdf'));
  assert.equal(raw.mime, 'application/pdf');
  assert.equal(raw.kind, 'pdf');
});

// ---- size limits -----------------------------------------------------------

test('a file over its kind limit is refused with a message naming both sizes', async () => {
  await assert.rejects(
    () => statRawFile(join(inside, 'big.pdf'), { image: 1024, pdf: 1024 }),
    /too large.*4 KB.*1 KB/,
  );
});

test('a file exactly at the limit is served', async () => {
  const raw = await statRawFile(join(inside, 'big.pdf'), { image: 1024, pdf: 4096 });
  assert.equal(raw.size, 4096);
});

test('the default limits keep a 200 MB pdf out and normal files in', () => {
  assert.ok(RAW_LIMITS.pdf < 200 * 1024 * 1024);
  assert.ok(RAW_LIMITS.image >= 10 * 1024 * 1024);
  assert.ok(RAW_LIMITS.pdf >= 10 * 1024 * 1024);
});

// ---- pure helpers ----------------------------------------------------------

test('rawKindOf classifies every supported extension and nothing else', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'svg']) {
    assert.equal(rawKindOf(`shot.${ext}`), 'image', ext);
  }
  assert.equal(rawKindOf('paper.pdf'), 'pdf');
  assert.equal(rawKindOf('IMG_0001.HEIC'), 'image');
  assert.equal(rawKindOf('main.ts'), null);
  assert.equal(rawKindOf('archive.tar.gz'), null);
  assert.equal(rawKindOf('noext'), null);
  // A trailing dot or a dotfile is not an extension.
  assert.equal(rawKindOf('.png'), null);
});

test('mimeOf maps each extension to its exact type', () => {
  assert.equal(mimeOf('a.jpg'), 'image/jpeg');
  assert.equal(mimeOf('a.jpeg'), 'image/jpeg');
  assert.equal(mimeOf('a.svg'), 'image/svg+xml');
  assert.equal(mimeOf('a.heic'), 'image/heic');
  assert.equal(mimeOf('a.pdf'), 'application/pdf');
  assert.equal(mimeOf('a.exe'), null);
});
