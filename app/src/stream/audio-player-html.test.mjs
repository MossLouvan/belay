import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { AUDIO_PLAYER_HTML } from './audio-player-html.ts';

function player({ audioSession = {}, state = 'suspended', resume } = {}) {
  const contexts = [];
  const messages = [];
  let now = 0;
  class AudioContext {
    state = state;
    currentTime = 1;
    destination = {};
    sources = [];
    resumes = 0;
    constructor() { contexts.push(this); }
    resume() {
      this.resumes += 1;
      if (resume) return resume.call(this);
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    createBuffer(channels, frames, rate) {
      return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() {
      const source = {
        stopped: false,
        connect() {}, disconnect() {},
        start(at) { this.at = at; },
        stop() { this.stopped = true; },
      };
      this.sources.push(source);
      return source;
    }
  }
  const window = { AudioContext, ReactNativeWebView: { postMessage: (m) => messages.push(m) } };
  const navigator = audioSession === null ? {} : { audioSession };
  vm.runInNewContext(AUDIO_PLAYER_HTML.match(/<script>([\s\S]*)<\/script>/)[1], {
    window, navigator, AudioContext, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Date: { now: () => now },
  });
  const frame = Buffer.from(new Float32Array(1920).buffer).toString('base64');
  return { audio: window.__belayAudio, audioSession, contexts, messages, frame, advance: (ms) => { now += ms; } };
}

test('explicit playback session makes host sound independent of the iPhone Silent switch', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  assert.equal(p.audioSession.type, 'playback');
  assert.equal(p.contexts[0].state, 'running');
});

test('older WebViews without Audio Session still start playback', async () => {
  const p = player({ audioSession: null });
  p.audio.start();
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  assert.equal(p.contexts[0].sources.length, 1);
});

test('an interrupted context resumes when returning to playback', async () => {
  const p = player({ state: 'interrupted' });
  p.audio.start();
  await Promise.resolve();
  assert.equal(p.contexts[0].resumes, 1);
});

test('mute discards scheduled sound and late frames cannot restart it', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  p.audio.stop();
  p.audio.enqueue(p.frame);
  assert.equal(p.contexts[0].sources.length, 1);
  assert.equal(p.contexts[0].sources[0].stopped, true);
  assert.equal(p.contexts[0].state, 'suspended');
});

test('playback failures are reported through the bridge', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  p.audio.enqueue('not valid base64');
  assert.ok(p.messages.some((m) => m.includes('error')));
});

test('a slow resume completing after mute is suspended again', async () => {
  let finish;
  const p = player({ resume() { return new Promise((done) => {
    finish = () => { this.state = 'running'; done(); };
  }); } });
  p.audio.start();
  p.audio.stop();
  finish();
  await Promise.resolve();
  assert.equal(p.contexts[0].state, 'suspended');
  p.audio.enqueue(p.frame);
  assert.equal(p.contexts[0].sources.length, 0);
});

test('first-frame playback status is re-armed after a transport reconnect', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  p.audio.enqueue(p.frame);
  p.audio.start();
  p.audio.enqueue(p.frame);
  assert.equal(p.messages.filter((m) => JSON.parse(m).phase === 'playing').length, 2);
  assert.equal(p.contexts.length, 1);
});

test('interruption during playback recovers without toggling and discards the scheduled tail', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  const c = p.contexts[0];
  const oldSource = c.sources[0];
  c.state = 'interrupted';
  c.onstatechange?.();
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  assert.equal(c.resumes, 2);
  assert.equal(c.state, 'running');
  assert.equal(oldSource.stopped, true);
  assert.equal(c.sources.length, 2);
  assert.equal(c.sources[1].at, c.currentTime + 0.08);
  assert.equal(p.messages.filter((m) => JSON.parse(m).phase === 'playing').length, 2);
});

test('frames recover a suspended context even when WebKit emits no statechange', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  p.contexts[0].state = 'suspended';
  p.audio.enqueue(p.frame);
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  assert.equal(p.contexts[0].resumes, 2);
  assert.equal(p.contexts[0].sources.length, 1);
});

test('recovery has only one pending resume and retries failures at most once per second', async () => {
  let reject;
  const p = player({ resume() {
    if (this.resumes === 1) { this.state = 'running'; return Promise.resolve(); }
    return new Promise((_, fail) => { reject = fail; });
  } });
  p.audio.start();
  await Promise.resolve();
  const c = p.contexts[0];
  c.state = 'interrupted';
  c.onstatechange?.();
  for (let i = 0; i < 100; i++) p.audio.enqueue(p.frame);
  assert.equal(c.resumes, 2);
  assert.equal(c.sources.length, 0);
  reject(new Error('still interrupted'));
  await Promise.resolve();
  await Promise.resolve();
  p.audio.enqueue(p.frame);
  assert.equal(c.resumes, 2);
  p.advance(1000);
  p.audio.enqueue(p.frame);
  assert.equal(c.resumes, 3);
});

test('a statechange after mute cannot restart playback', async () => {
  const p = player();
  p.audio.start();
  await Promise.resolve();
  p.audio.stop();
  p.contexts[0].onstatechange?.();
  p.audio.enqueue(p.frame);
  assert.equal(p.contexts[0].resumes, 1);
  assert.equal(p.contexts[0].state, 'suspended');
});
