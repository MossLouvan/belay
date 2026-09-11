// The parity rules, tested against a fake pty: a session that several clients
// share, that outlives all of them, and that never silently clips anyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendScrollback, clampDim, clientSize, minSize, DEFAULT_SIZE,
  MIN_CLIENT_COLS, MIN_CLIENT_ROWS,
} from '../src/agent-pty-buffer.js';
import {
  buildPtyArgs, createPtyRegistry, detectClaudeSessionId, INHERITED_CLAUDE_MARKERS, ptyEnv,
  transcriptIdsFor,
} from '../src/agent-pty.js';
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
    // These sessions live in folders that do not exist, so the real
    // ~/.claude/projects has nothing to say about them. `null` is the
    // registry's "could not tell", which is what an unreadable or irrelevant
    // projects root honestly is here — tests that care about the transcripts
    // on disk pass their own set.
    existingIds: () => null,
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

// ---- the lifecycle a stop has to announce ----------------------------------
//
// The fake above fires its exit callbacks straight out of kill(), which is the
// one thing a real pty never does: node-pty's onExit lands on a later tick.
// That gap is where the blocker lived, so these tests use a pty that behaves
// like the real one.

interface SlowPty extends PtyHandle {
  readonly spec: SpawnSpec;
  readonly sizes: { cols: number; rows: number }[];
  killed: boolean;
  /** Deliver the exit node-pty would have delivered a tick later. */
  flushExit(): void;
}

function slowExitPty(spec: SpawnSpec): SlowPty {
  const exitCbs: (() => void)[] = [];
  const pty: SlowPty = {
    spec,
    sizes: [],
    killed: false,
    write: () => {},
    resize: (cols, rows) => { pty.sizes.push({ cols, rows }); },
    onData: () => {},
    onExit: (cb) => { exitCbs.push(cb); },
    kill: () => { pty.killed = true; },
    flushExit: () => { for (const cb of exitCbs) cb(); },
  };
  return pty;
}

function slowRegistry() {
  const spawned: SlowPty[] = [];
  const registry = createPtyRegistry({
    reap: false,
    existingIds: () => null,
    spawn: async (spec) => { const p = slowExitPty(spec); spawned.push(p); return p; },
  });
  return { registry, spawned };
}

/** A recorder that counts exits rather than only remembering that one happened. */
function counting(cols = 100, rows = 40) {
  const rec = recorder(cols, rows);
  let exits = 0;
  return {
    client: { ...rec, onExit: () => { exits += 1; rec.exited = true; } } as AttachClient,
    exits: () => exits,
  };
}

test('stop tells every attached client the session is over, without waiting for the pty', async () => {
  const { registry, spawned } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const a = counting();
  const b = counting();
  await registry.attach('s1', a.client);
  await registry.attach('s1', b.client);

  registry.stop('s1');

  // Before this fix the exit handler bailed on the very state stop() had just
  // created, so both clients sat on a live-looking dead terminal for ever.
  assert.equal(a.exits(), 1);
  assert.equal(b.exits(), 1);
  assert.equal(spawned[0].killed, true);
  assert.equal(registry.info('s1')!.running, false);
  // `attached` used to stay pinned at 2 in every REST payload after a stop.
  assert.equal(registry.info('s1')!.attached, 0);
});

test('the pty exit that lands after a stop does not announce the session twice', async () => {
  const { registry, spawned } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const a = counting();
  await registry.attach('s1', a.client);

  registry.stop('s1');
  spawned[0].flushExit();

  assert.equal(a.exits(), 1);
});

test('remove notifies its clients exactly once, not once by hand and again on exit', async () => {
  const { registry, spawned } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const a = counting();
  await registry.attach('s1', a.client);

  registry.remove('s1');
  spawned[0].flushExit();

  assert.equal(a.exits(), 1);
  assert.equal(registry.has('s1'), false);
});

test('removing a session that never started still tells its clients', async () => {
  const { registry } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  registry.remove('s1');
  assert.equal(registry.has('s1'), false);
});

test('a pty that exits on its own still reaches every client', async () => {
  const { registry, spawned } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const a = counting();
  await registry.attach('s1', a.client);

  spawned[0].flushExit();

  assert.equal(a.exits(), 1);
  assert.equal(registry.info('s1')!.running, false);
  assert.equal(registry.info('s1')!.attached, 0);
});

// ---- the size race in the spawn window -------------------------------------

test('a size negotiated while the pty was still spawning reaches the pty', async () => {
  const spawned: SlowPty[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = createPtyRegistry({
    reap: false,
    existingIds: () => null,
    spawn: async (spec) => {
      await gate;
      const p = slowExitPty(spec);
      spawned.push(p);
      return p;
    },
  });
  registry.register({ id: 's1', cwd: '/tmp/demo' });

  // A starts the spawn at 100x30; B joins at 80x24 while it is still in flight.
  const first = registry.attach('s1', recorder(100, 30));
  const second = registry.attach('s1', recorder(80, 24));
  release!();
  await Promise.all([first, second]);

  // The pty was born 100x30 — nothing can change that — so it has to be told.
  // Before this fix it was told nothing at all: applySize's resize went to an
  // undefined handle, and the session rendered 100 columns wide for its whole
  // life while the registry insisted it was 80.
  assert.deepEqual(registry.info('s1')!.size, { cols: 80, rows: 24 });
  assert.deepEqual(spawned[0].sizes.at(-1), { cols: 80, rows: 24 });
});

test('the pty is told its size after every spawn, so no session is born out of sync', async () => {
  const { registry, spawned } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.attach('s1', recorder(120, 40));
  assert.deepEqual(spawned[0].sizes.at(-1), { cols: 120, rows: 40 });
});

// ---- the size floor --------------------------------------------------------

test('one client reporting a degenerate size is letterboxed, not obeyed', () => {
  assert.deepEqual(minSize([{ cols: 1, rows: 1 }, { cols: 100, rows: 40 }]), { cols: MIN_CLIENT_COLS, rows: MIN_CLIENT_ROWS });
});

test('clientSize floors a dimension without touching a usable one', () => {
  assert.deepEqual(clientSize({ cols: 3, rows: 2 }), { cols: MIN_CLIENT_COLS, rows: MIN_CLIENT_ROWS });
  assert.deepEqual(clientSize({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
  // A nonsense number still falls back first, then meets the floor.
  assert.deepEqual(clientSize({ cols: 0, rows: 0 }, { cols: 100, rows: 30 }), { cols: 100, rows: 30 });
});

test('a phone whose keyboard collapses its viewport cannot drag the shared pty to nothing', async () => {
  const { registry, spawned } = slowRegistry();
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  const desk = recorder(160, 50);
  await registry.attach('s1', desk);
  const phone = await registry.attach('s1', recorder(60, 30));

  phone!.resize(1, 1);

  assert.deepEqual(registry.info('s1')!.size, { cols: MIN_CLIENT_COLS, rows: MIN_CLIENT_ROWS });
  assert.deepEqual(spawned[0].sizes.at(-1), { cols: MIN_CLIENT_COLS, rows: MIN_CLIENT_ROWS });
});

// ---- which conversation is ours -------------------------------------------
//
// Fixtures are synthetic transcripts in a temp dir, as in discover.test.ts —
// no real ~/.claude is touched.

function transcripts() {
  const root = mkdtempSync(join(tmpdir(), 'belay-pty-detect-'));
  const projects = join(root, 'projects');
  const proj = join(projects, 'C--fake-proj');
  mkdirSync(proj, { recursive: true });
  const cwd = root;
  const write = (id: string, ageMin = 0): void => {
    const file = join(proj, `${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`, 'utf8');
    const t = new Date(Date.now() - ageMin * 60000);
    utimesSync(file, t, t);
  };
  return { projects, cwd, write };
}

test('detection ignores transcripts that were already there when the pty spawned', () => {
  const { projects, cwd, write } = transcripts();
  // Another Belay session in the same project, and the user's own `claude` in
  // that folder — both newer than our spawn, neither ours.
  write('1111aaaa-0000-0000-0000-000000000001');
  write('2222bbbb-0000-0000-0000-000000000002');
  const before = transcriptIdsFor(cwd, projects)!;
  assert.equal(before.size, 2);

  // Nothing new has appeared yet, so there is nothing to claim.
  assert.equal(detectClaudeSessionId(cwd, Date.now() - 1000, before, projects), null);

  write('3333cccc-0000-0000-0000-000000000003');
  assert.equal(
    detectClaudeSessionId(cwd, Date.now() - 1000, before, projects),
    '3333cccc-0000-0000-0000-000000000003',
  );
});

test('two new transcripts in the same folder means neither is claimed', () => {
  const { projects, cwd, write } = transcripts();
  const before = transcriptIdsFor(cwd, projects)!;
  write('aaaa1111-0000-0000-0000-000000000001');
  write('bbbb2222-0000-0000-0000-000000000002');
  // The user started a `claude` of his own in this folder a second after Belay
  // did. Recording the newest would revive into his conversation later, which
  // looks exactly like success — so nothing is recorded.
  assert.equal(detectClaudeSessionId(cwd, Date.now() - 1000, before, projects), null);
});

test('a transcript from before the spawn window is never claimed even if unknown', () => {
  const { projects, cwd, write } = transcripts();
  write('cccc3333-0000-0000-0000-000000000003', 60);
  assert.equal(detectClaudeSessionId(cwd, Date.now(), new Set(), projects), null);
});

test('transcriptIdsFor says "could not tell" rather than "none" when there is no projects root', () => {
  // The difference decides whether a saved conversation is declared deleted.
  assert.equal(transcriptIdsFor('/tmp/demo', join(tmpdir(), 'belay-no-such-root-here')), null);
  const { projects, cwd } = transcripts();
  assert.deepEqual(transcriptIdsFor(cwd, projects), new Set());
});

test('the registry hands the detector the ids that existed before the spawn', async () => {
  const seenBefore: ReadonlySet<string>[] = [];
  const registry = createPtyRegistry({
    reap: false,
    detectIntervalMs: 1,
    existingIds: () => new Set(['theirs-1', 'theirs-2']),
    detect: (_cwd, _since, before) => { seenBefore.push(before); return null; },
    spawn: async (spec) => slowExitPty(spec),
  });
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.ensureRunning('s1');
  await new Promise((r) => setTimeout(r, 20));
  registry.dispose();

  assert.ok(seenBefore.length > 0, 'the detector never ran');
  assert.deepEqual([...seenBefore[0]].sort(), ['theirs-1', 'theirs-2']);
});

test('a session whose conversation was never identified says so instead of looking resumable', async () => {
  const registry = createPtyRegistry({
    reap: false,
    detectIntervalMs: 1,
    detectTries: 2,
    existingIds: () => new Set(),
    detect: () => null,
    spawn: async (spec) => slowExitPty(spec),
  });
  registry.register({ id: 's1', cwd: '/tmp/demo' });
  await registry.ensureRunning('s1');
  assert.equal(registry.info('s1')!.detect, 'pending');
  assert.equal(registry.info('s1')!.resumable, false);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(registry.info('s1')!.detect, 'unknown');
  assert.equal(registry.info('s1')!.claudeSessionId, undefined);
  registry.dispose();
});

test('a resume whose transcript is gone clears the id instead of retrying it forever', async () => {
  const specs: SpawnSpec[] = [];
  const registry = createPtyRegistry({
    reap: false,
    detectIntervalMs: 60_000,
    // The projects root is readable and this conversation is not in it.
    existingIds: () => new Set(['somebody-elses']),
    detect: () => null,
    spawn: async (spec) => { specs.push(spec); return slowExitPty(spec); },
  });
  registry.register({ id: 's1', cwd: '/tmp/demo', claudeSessionId: 'deleted-conversation' });

  await registry.ensureRunning('s1');
  // Noticed before the spawn, so not even the first attempt wastes a --resume.
  assert.equal(specs[0].claudeSessionId, undefined);
  assert.equal(registry.info('s1')!.resumable, false);
  // Back to watching: this pty is a fresh conversation, and it can still be
  // identified — what it can never do is keep pointing at a deleted one.
  assert.equal(registry.info('s1')!.detect, 'pending');

  registry.stop('s1');
  await registry.ensureRunning('s1');
  // The second attempt no longer carries a --resume that can only fail.
  assert.equal(specs[1].claudeSessionId, undefined);
  registry.dispose();
});
