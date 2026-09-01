// The recorder is the first thing in this server that could quietly fill a
// disk or run a camera the user forgot about, so these tests are about the
// caps and the lifecycle: every ceiling actually stops the loop, discard
// leaves zero bytes anywhere, and delivery both confines its writes and
// prunes its own history.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { Recorder, pruneRecordings } from '../src/recording.js';
import { RECORDING } from '../src/recording-frames.js';

// Frames must land inside the allow-list roots, so the sandbox project lives
// under $HOME (the same pattern as projects.test.ts), while the escape target
// lives in the real tmpdir, outside every root.
let project = '';
let outside = '';

before(async () => {
  project = join(homedir(), '.deskhandler-test-recordings');
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  outside = await mkdtemp(join(tmpdir(), 'deskhandler-rec-outside-'));
});

after(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** A capture source yielding distinct frames, or a scripted sequence. */
function fakeCapture(script?: readonly string[]) {
  let n = 0;
  return async () => {
    const data = script ? script[Math.min(n, script.length - 1)] : `frame-${n}`;
    n += 1;
    return { data: Buffer.from(data).toString('base64'), bytes: data.length };
  };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('start → stop → ready, with frames counted and state reported', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 5 });
  const started = recorder.start(1);
  assert.equal(started.state, 'recording');
  assert.equal(started.screen, 1);
  await settle();
  const stopped = recorder.stop();
  assert.equal(stopped.state, 'ready');
  assert.ok(stopped.frames >= 2);
  assert.ok(stopped.bytes > 0);
});

test('a second start while recording is refused', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 5 });
  recorder.start();
  assert.throws(() => recorder.start(), /already running/);
  recorder.discard();
});

test('byte-identical frames are dropped, not kept', async () => {
  const recorder = new Recorder({ capture: fakeCapture(['same', 'same', 'same', 'same']), intervalMs: 5 });
  recorder.start();
  await settle();
  const status = recorder.stop();
  assert.equal(status.frames, 1);
  assert.ok(status.dropped >= 2);
});

test('the frame-count cap stops the recording on its own', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 1, maxFrames: 4 });
  recorder.start();
  await settle(80);
  const status = recorder.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.frames, 4);
  assert.equal(status.autoStopped, 'frames');
  recorder.discard();
});

test('the byte cap stops the recording on its own', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 1, maxBytes: 10 });
  recorder.start();
  await settle(80);
  const status = recorder.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.autoStopped, 'bytes');
  recorder.discard();
});

test('the duration cap stops the recording on its own', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 1, maxDurationMs: 20 });
  recorder.start();
  await settle(80);
  const status = recorder.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.autoStopped, 'duration');
  recorder.discard();
});

test('persistent capture failure gives up instead of spinning forever', async () => {
  const recorder = new Recorder({
    capture: async () => { throw new Error('helper is down'); },
    intervalMs: 1,
    maxConsecutiveErrors: 3,
  });
  recorder.start();
  await settle(80);
  const status = recorder.status();
  // No frames were ever captured, so there is nothing to review either.
  assert.equal(status.state, 'idle');
  assert.equal(status.lastError, 'helper is down');
});

test('discard resets everything and writes nothing to disk', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 5 });
  recorder.start();
  await settle();
  recorder.stop();
  const status = recorder.discard();
  assert.equal(status.state, 'idle');
  assert.equal(status.frames, 0);
  assert.equal(status.bytes, 0);
  assert.equal(existsSync(join(project, '.deskhandler')), false);
});

test('deliver writes ≤ maxKept ordered frames into the project and resets', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 1, maxFrames: 100 });
  recorder.start();
  await settle(150);
  if (recorder.status().state === 'recording') recorder.stop();
  const before = recorder.status().frames;
  const delivery = await recorder.deliver(project, 'watch the flicker');

  assert.ok(delivery.frames.length <= RECORDING.maxKept);
  assert.ok(delivery.frames.length > 0);
  assert.equal(delivery.frames.length, Math.min(before, RECORDING.maxKept));
  assert.match(delivery.relDir, /^\.deskhandler[\\/]recordings[\\/]rec-\d{8}-\d{6}$/);
  assert.match(delivery.prompt, /watch the flicker/);

  const written = (await readdir(delivery.dir)).sort();
  assert.deepEqual(written, [...delivery.frames].sort());
  assert.equal(recorder.status().state, 'idle');

  // A second deliver has nothing to send.
  await assert.rejects(() => recorder.deliver(project), /no stopped recording/);
});

test('deliver refuses a project outside the allowed roots', async () => {
  const recorder = new Recorder({ capture: fakeCapture(), intervalMs: 5 });
  recorder.start();
  await settle();
  recorder.stop();
  await assert.rejects(() => recorder.deliver(outside), /outside the allowed folders/);
  recorder.discard();
});

test('pruneRecordings keeps the newest maxSaved and ignores foreign files', async () => {
  const recordingsDir = join(project, '.deskhandler', 'recordings');
  await rm(recordingsDir, { recursive: true, force: true });
  await mkdir(recordingsDir, { recursive: true });
  const names = [
    'rec-20260825-090000', 'rec-20260826-090000', 'rec-20260827-090000',
    'rec-20260828-090000', 'rec-20260829-090000', 'rec-20260830-090000',
  ];
  for (const name of names) await mkdir(join(recordingsDir, name));
  await writeFile(join(recordingsDir, 'keep-me.txt'), 'not a recording\n', 'utf8');

  await pruneRecordings(recordingsDir, 5);
  const left = (await readdir(recordingsDir)).sort();
  assert.deepEqual(left, ['keep-me.txt', ...names.slice(1)]);
});

test('pruneRecordings tolerates a missing directory', async () => {
  await pruneRecordings(join(project, 'no-such-dir'), 5);
});
