// The serialized capture lifecycle: refcount, retry-on-failed-start, no
// start/stop interleave, and the REST-stop-under-listeners guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AudioCaptureController, type CaptureBackend } from '../src/audio-capture.js';

interface MockBackend extends CaptureBackend {
  startCalls: number;
  stopCalls: number;
}

/** Backend that counts calls, asserts start/stop never overlap, and can be told
 *  to fail its first N starts. */
function makeBackend(startFailTimes = 0): MockBackend {
  let inFlight = false;
  let failLeft = startFailTimes;
  const noOverlap = async (): Promise<void> => {
    assert.equal(inFlight, false, 'start/stop overlapped — serialization broken');
    inFlight = true;
    await Promise.resolve();
    inFlight = false;
  };
  const backend: MockBackend = {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      this.startCalls += 1;
      await noOverlap();
      if (failLeft > 0) { failLeft -= 1; throw new Error('start failed'); }
    },
    async stop() {
      this.stopCalls += 1;
      await noOverlap();
    },
  };
  return backend;
}

test('(a) a failed first start does not strand a second waiter — it retries and serves it', async () => {
  const backend = makeBackend(1); // first start fails, second succeeds
  const c = new AudioCaptureController(backend);

  const first = c.acquire();
  const second = c.acquire();

  await assert.rejects(first, /start failed/);
  await second; // the later waiter re-drove the start and got capture

  assert.equal(c.capturingNow, true);
  assert.equal(backend.startCalls, 2, 'start was retried for the second waiter');
  assert.equal(backend.stopCalls, 0);
});

test('(a) a start that keeps failing rejects its waiter rather than hanging', async () => {
  const backend = makeBackend(99);
  const c = new AudioCaptureController(backend);
  await assert.rejects(c.acquire(), /start failed/);
  assert.equal(c.capturingNow, false);
});

test('(b) close-then-immediate-reopen stays running with no stop/start churn', async () => {
  const backend = makeBackend();
  const c = new AudioCaptureController(backend);
  await c.acquire();
  assert.equal(backend.startCalls, 1);

  // Last release and a new acquire arrive back-to-back with no await between.
  const rel = c.release();
  const acq = c.acquire();
  await Promise.all([rel, acq]);

  assert.equal(c.capturingNow, true);
  assert.equal(backend.stopCalls, 0, 'transient close-reopen must not stop capture');
  assert.equal(backend.startCalls, 1, 'and must not restart it');
});

test('(b) a genuine last close stops capture', async () => {
  const backend = makeBackend();
  const c = new AudioCaptureController(backend);
  await c.acquire();
  await c.release();
  assert.equal(c.capturingNow, false);
  assert.equal(backend.stopCalls, 1);
});

test('(c) REST stop is refused while a listener is active, and never touches the backend', async () => {
  const backend = makeBackend();
  const c = new AudioCaptureController(backend);
  await c.acquire();

  const outcome = await c.requestExternalStop();
  assert.equal(outcome.stopped, false);
  assert.equal(outcome.listeners, 1);
  assert.equal(c.capturingNow, true, 'capture stays up under an active listener');
  assert.equal(backend.stopCalls, 0);

  // Once the listener leaves, capture stops normally.
  await c.release();
  assert.equal(c.capturingNow, false);
});

test('(c) REST stop with no listeners is allowed (idle no-op)', async () => {
  const backend = makeBackend();
  const c = new AudioCaptureController(backend);
  const outcome = await c.requestExternalStop();
  assert.equal(outcome.stopped, true);
  assert.equal(c.capturingNow, false);
});

test('interleaved acquires/releases converge to a coherent state', async () => {
  const backend = makeBackend();
  const c = new AudioCaptureController(backend);
  // Three in, three out, kicked off together.
  const ops = [c.acquire(), c.acquire(), c.acquire()];
  await Promise.all(ops);
  assert.equal(c.listeners, 3);
  assert.equal(c.capturingNow, true);

  await Promise.all([c.release(), c.release(), c.release()]);
  assert.equal(c.listeners, 0);
  assert.equal(c.capturingNow, false);
});
