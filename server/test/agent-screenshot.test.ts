// The screenshot route's pure half: the caps a one-shot display grab uses and
// the prompt handed to Claude alongside it. The capture and delivery are the
// native helper's and ImageDrop's business — already tested where they live —
// so these tests pin only what agent-routes.ts itself decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCREENSHOT, buildScreenshotPrompt } from '../src/agent-routes.js';

test('screenshot caps favour legible UI text over stream thrift', () => {
  // A one-shot frame can afford what the live stream cannot: full width and
  // high quality, because it is one JPEG, not thirty a second.
  assert.equal(SCREENSHOT.width, 1920);
  assert.ok(SCREENSHOT.quality >= 70);
  assert.ok(Object.isFrozen(SCREENSHOT));
});

test('the prompt names the file, says it is the live display, and forbids committing it', () => {
  const prompt = buildScreenshotPrompt({
    relDir: '.belay/images/img-20260903-101500',
    fileName: 'photo-01.jpg',
    note: undefined,
  });
  assert.match(prompt, /screenshot of this computer's current display/);
  assert.match(prompt, /\.belay\/images\/img-20260903-101500\/photo-01\.jpg/);
  assert.match(prompt, /do not commit/);
});

test('a note becomes the ask; without one Claude is asked to describe what it sees', () => {
  const asked = buildScreenshotPrompt({
    relDir: '.belay/images/img-x',
    fileName: 'photo-01.jpg',
    note: '  why is this dialog stuck?  ',
  });
  assert.match(asked, /why is this dialog stuck\?/);
  assert.ok(!/^\s|\s{2,}why/.test(asked.split('then: ')[1] ?? ''), 'the note is trimmed into the ask');

  const bare = buildScreenshotPrompt({ relDir: '.belay/images/img-x', fileName: 'photo-01.jpg' });
  assert.match(bare, /describe what is on the screen/);
});
