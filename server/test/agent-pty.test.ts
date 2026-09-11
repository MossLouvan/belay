// The parity rules, tested against a fake pty: a session that several clients
// share, that outlives all of them, and that never silently clips anyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendScrollback, clampDim, minSize, DEFAULT_SIZE,
} from '../src/agent-pty-buffer.js';
import { buildPtyArgs, createPtyRegistry, INHERITED_CLAUDE_MARKERS, ptyEnv } from '../src/agent-pty.js';
import type { AttachClient, PtyHandle, SpawnSpec } from '../src/agent-pty.js';

// ---- a pty that is really just an array -----------------------------------

interface FakePty extends PtyHandle {
  readonly spec: SpawnSpec;
  readonly written: string[];
  readonly sizes: { cols: number; rows: number }[];
  killed: boolean;
  emit(data: string): void;
  finish(): void;
}

function fakePty(spec: SpawnSpec): FakePty {
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  const pty: FakePty = {
    spec,
    written: [],
    sizes: [],
    killed: false,
    write: (d) => { pty.written.push(d); },
    resize: (cols, rows) => { pty.sizes.push({ cols, rows }); },
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    kill: () => { pty.killed = true; for (const cb of exitCbs) cb(); },
    emit: (data) => { for (const cb of dataCbs) cb(data); },
    finish: () => { for (const cb of exitCbs) cb(); },
  };
  return pty;
}

function registryWithFakePty(extra: Record<string, unknown> = {}) {
  const spawned: FakePty[] = [];
  const registry = createPtyRegistry({
    reap: false,
    spawn: async (spec) => { const p = fakePty(spec); spawned.push(p); return p; },
    ...extra,
  });
  return { registry, spawned };
}

interface Recorder extends AttachClient {
  readonly seen: string[];
  readonly sizeChanges: { cols: number; rows: number }[];
  exited: boolean;
  saturated: boolean;
  size: { cols: number; rows: number };
}

function recorder(cols = 100, rows = 40): Recorder {
  const rec: Recorder = {
    seen: [],
    sizeChanges: [],
    exited: false,
    saturated: false,
    size: { cols, rows },
    onData: (d) => { rec.seen.push(d); },
    onExit: () => { rec.exited = true; },
    onSize: (s) => { rec.sizeChanges.push({ cols: s.cols, rows: s.rows }); },
    accepts: () => !rec.saturated,
  };
  return rec;
}

// ---- scrollback ------------------------------------------------------------

test('scrollback keeps everything while it is under the cap', () => {
  const ring = appendScrollback('', 'hello\nworld\n', 1024);
  assert.equal(ring, 'hello\nworld\n');
});

test('scrollback trims from the front, on a line boundary, to stay under the cap', () => {
  const lines = ['aaaa', 'bbbb', 'cccc', 'dddd'].map((l) => `${l}\n`).join('');
  const ring = appendScrollback(lines, '', 12);
  assert.ok(ring.length <= 12, `ring is ${ring.length} bytes`);
  // The cut landed on a boundary, so the replay starts at the start of a line.
  assert.ok(ring.startsWith('cccc') || ring.startsWith('dddd'), ring);
  assert.ok(!ring.includes('aaaa'));
});

test('scrollback falls back to a hard cut when the tail has no newline at all', () => {
  const ring = appendScrollback('', 'x'.repeat(100), 10);
  assert.equal(ring.length, 10);
  assert.equal(ring, 'x'.repeat(10));
});

test('scrollback never mutates its input', () => {
  const before = 'one\ntwo\n';
  appendScrollback(before, 'three\n', 4);
  assert.equal(before, 'one\ntwo\n');
});

test('a client attaching mid-session is replayed the current screen', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.ensureRunning('s1');
  spawned[0].emit('a build log line\n');
  spawned[0].emit('and another\n');

  const late = recorder();
  await registry.attach('s1', late);
  assert.equal(late.seen.join(''), 'a build log line\nand another\n');
});

// ---- the minimum-size rule -------------------------------------------------

test('minSize picks the smallest cols and rows independently', () => {
  const size = minSize([{ cols: 200, rows: 20 }, { cols: 60, rows: 50 }]);
  assert.deepEqual(size, { cols: 60, rows: 20 });
});

test('minSize keeps the last size when nobody is attached', () => {
  assert.deepEqual(minSize([], { cols: 120, rows: 40 }), { cols: 120, rows: 40 });
  assert.deepEqual(minSize([]), DEFAULT_SIZE);
});

test('clampDim refuses nonsense and bounds the range', () => {
  assert.equal(clampDim('0', 24), 24);
  assert.equal(clampDim(-5, 24), 24);
  assert.equal(clampDim('abc', 80), 80);
  assert.equal(clampDim(99999, 80), 1000);
  assert.equal(clampDim('120', 80), 120);
});

test('the pty is sized to the smallest attached client, recomputed on attach, resize and detach', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });

  const laptop = recorder(200, 50);
  const a = await registry.attach('s1', laptop);
  assert.deepEqual(a!.size(), { cols: 200, rows: 50 });

  // A phone joins: everyone is now clipped to the phone, so nothing the
  // program draws is off anyone's screen.
  const phone = recorder(60, 30);
  const b = await registry.attach('s1', phone);
  assert.deepEqual(b!.size(), { cols: 60, rows: 30 });
  assert.deepEqual(spawned[0].sizes.at(-1), { cols: 60, rows: 30 });
  // Both clients were told what they actually got.
  assert.deepEqual(laptop.sizeChanges.at(-1), { cols: 60, rows: 30 });

  // The phone turns sideways.
  b!.resize(80, 25);
  assert.deepEqual(a!.size(), { cols: 80, rows: 25 });

  // The phone leaves: the laptop gets its whole window back.
  b!.detach();
  assert.deepEqual(a!.size(), { cols: 200, rows: 50 });
  assert.deepEqual(spawned[0].sizes.at(-1), { cols: 200, rows: 50 });
});

test('an unattended session keeps its last size rather than collapsing', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const only = await registry.attach('s1', recorder(120, 40));
  only!.detach();
  assert.deepEqual(registry.info('s1')!.size, { cols: 120, rows: 40 });
  assert.equal(spawned[0].killed, false);
});

// ---- fan-out ---------------------------------------------------------------

test('output goes to every attached client and input from any of them goes to the pty', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });

  const one = recorder();
  const two = recorder();
  const three = recorder();
  const a = await registry.attach('s1', one);
  const b = await registry.attach('s1', two);
  await registry.attach('s1', three);
  assert.equal(a!.attached(), 3);

  spawned[0].emit('claude says hello\n');
  assert.equal(one.seen.join(''), 'claude says hello\n');
  assert.equal(two.seen.join(''), 'claude says hello\n');
  assert.equal(three.seen.join(''), 'claude says hello\n');

  a!.write('from the desk');
  b!.write('from the phone');
  assert.deepEqual(spawned[0].written, ['from the desk', 'from the phone']);

  // Only one process was ever started, no matter how many clients joined.
  assert.equal(spawned.length, 1);
});

test('a saturated client is dropped, not buffered, and the pty is never paused for it', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const fast = recorder();
  const slow = recorder();
  await registry.attach('s1', fast);
  await registry.attach('s1', slow);

  slow.saturated = true;
  spawned[0].emit('line one\n');
  spawned[0].emit('line two\n');
  assert.equal(fast.seen.join(''), 'line one\nline two\n');
  assert.equal(slow.seen.join(''), '');

  // When it drains it is told there is a hole, rather than the gap passing
  // for output that never happened.
  slow.saturated = false;
  spawned[0].emit('line three\n');
  const caught = slow.seen.join('');
  assert.match(caught, /output skipped/);
  assert.match(caught, /line three/);
  // The fast client never missed anything while the slow one was stuck.
  assert.equal(fast.seen.join(''), 'line one\nline two\nline three\n');
});

// ---- lifecycle -------------------------------------------------------------

test('detaching every client does not kill the session', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const a = await registry.attach('s1', recorder());
  const b = await registry.attach('s1', recorder());

  a!.detach();
  b!.detach();

  assert.equal(spawned[0].killed, false);
  assert.equal(registry.info('s1')!.running, true);
  assert.equal(registry.info('s1')!.attached, 0);

  // And the work it does while nobody is watching is still there to be seen.
  spawned[0].emit('finished the refactor\n');
  const returning = recorder();
  await registry.attach('s1', returning);
  assert.match(returning.seen.join(''), /finished the refactor/);
});

test('the idle reaper measures silence, not loneliness', async () => {
  let clock = 1_000_000;
  const { registry, spawned } = registryWithFakePty({ now: () => clock, idleKillMs: 1000 });
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.ensureRunning('s1');

  // Unattended but working: not abandoned.
  clock += 5000;
  spawned[0].emit('still running tests\n');
  assert.deepEqual(registry.reapIdle(), []);

  // Unattended and silent past the window: abandoned.
  clock += 5000;
  assert.deepEqual(registry.reapIdle(), ['s1']);
  assert.equal(spawned[0].killed, true);
});

test('a session with a client attached is never reaped, however quiet', async () => {
  let clock = 1_000_000;
  const { registry, spawned } = registryWithFakePty({ now: () => clock, idleKillMs: 1000 });
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.attach('s1', recorder());
  clock += 60_000;
  assert.deepEqual(registry.reapIdle(), []);
  assert.equal(spawned[0].killed, false);
});

test('the pty exiting tells every client, once', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const one = recorder();
  const two = recorder();
  await registry.attach('s1', one);
  await registry.attach('s1', two);

  spawned[0].finish();
  assert.equal(one.exited, true);
  assert.equal(two.exited, true);
  assert.equal(registry.info('s1')!.running, false);
  assert.equal(registry.info('s1')!.attached, 0);
});

// ---- revive across a host restart ------------------------------------------

test('a fresh session runs plain `claude`, with no flags at all', () => {
  assert.deepEqual(buildPtyArgs(), []);
  assert.deepEqual(buildPtyArgs(undefined), []);
});

test('only a revive passes --resume', () => {
  assert.deepEqual(buildPtyArgs('11111111-2222-3333-4444-555555555555'),
    ['--resume', '11111111-2222-3333-4444-555555555555']);
});

test('a session registered from persisted metadata revives with --resume on the first attach', async () => {
  // What loadAgentState does after a host restart: the process is gone, the
  // metadata is not.
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo', claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(registry.info('s1')!.running, false);

  const arriving = recorder();
  await registry.attach('s1', arriving);

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].spec.claudeSessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(registry.info('s1')!.running, true);
});

test('the claude session id recovered from disk is reported once, so it can be persisted', async () => {
  const seen: string[] = [];
  const { registry } = registryWithFakePty({
    onClaudeSessionId: (id: string, claudeSessionId: string) => { seen.push(`${id}:${claudeSessionId}`); },
    detect: () => 'ffffffff-1111-2222-3333-444444444444',
    detectIntervalMs: 5,
  });
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.ensureRunning('s1');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(registry.info('s1')!.claudeSessionId, 'ffffffff-1111-2222-3333-444444444444');
  // Reported once, not on every tick — this is what agent.ts persists on.
  assert.deepEqual(seen, ['s1:ffffffff-1111-2222-3333-444444444444']);
  registry.dispose();
});

test('stop kills the process but keeps the session, so it can be started again', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo', claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  await registry.ensureRunning('s1');
  registry.stop('s1');
  assert.equal(spawned[0].killed, true);
  assert.equal(registry.has('s1'), true);
  assert.equal(registry.info('s1')!.running, false);

  await registry.ensureRunning('s1');
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].spec.claudeSessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('two simultaneous attaches start exactly one process', async () => {
  const { registry, spawned } = registryWithFakePty();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await Promise.all([
    registry.attach('s1', recorder()),
    registry.attach('s1', recorder()),
  ]);
  assert.equal(spawned.length, 1);
});

test('attaching to a session that does not exist is null, not a crash', async () => {
  const { registry } = registryWithFakePty();
  assert.equal(await registry.attach('nope', recorder()), null);
});

test('a spawn failure surfaces to the attacher and leaves no phantom client', async () => {
  const registry = createPtyRegistry({
    reap: false,
    spawn: async () => { throw new Error('claude CLI not found on PATH'); },
  });
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await assert.rejects(() => registry.attach('s1', recorder()), /claude CLI not found/);
  assert.equal(registry.info('s1')!.attached, 0);
});

// ---- the environment a session's claude runs in ----------------------------

test('the session env is scrubbed of the markers Claude Code sets for its own children', () => {
  const env = ptyEnv({
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: 'abc',
    CLAUDE_CODE_SESSION_ID: 'def',
    CLAUDE_PID: '4242',
  }, 'darwin');
  for (const marker of INHERITED_CLAUDE_MARKERS) assert.equal(marker in env, false, marker);
  assert.equal(env.PATH, '/usr/bin');
});

test('a user\'s own CLAUDE_* configuration is passed through untouched', () => {
  const env = ptyEnv({ CLAUDE_CONFIG_DIR: '/somewhere', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' }, 'darwin');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/somewhere');
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8000');
});

test('the session env marks itself for the hook script and gives the TUI a usable terminal', () => {
  const env = ptyEnv({ PATH: '/usr/bin' }, 'darwin');
  assert.equal(env.BELAY_SPAWNED, '1');
  assert.equal(env.BELAY_PTY_SESSION, '1');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.LANG, 'en_US.UTF-8');
});

test('an existing TERM is respected, and windows is left to ConPTY', () => {
  assert.equal(ptyEnv({ TERM: 'screen-256color' }, 'darwin').TERM, 'screen-256color');
  const win = ptyEnv({ PATH: 'C:\\Windows' }, 'win32');
  assert.equal(win.TERM, undefined);
  assert.equal(win.BELAY_SPAWNED, '1');
});

test('ptyEnv never mutates the environment it was handed', () => {
  const input = { CLAUDECODE: '1', PATH: '/usr/bin' };
  ptyEnv(input, 'darwin');
  assert.deepEqual(input, { CLAUDECODE: '1', PATH: '/usr/bin' });
});
