// Tests for the completion dance in ../src/terminal-complete.ts.
//
// The pty is faked: a session that records writes and lets each test script
// the shell's echo through the completer's own filter(), exactly as index.ts
// wires the real one. Timings are shrunk so the settle/ceiling behaviour is
// exercised in milliseconds rather than felt in seconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCompleter, sanitizeCompletionLine } from '../src/terminal-complete.js';
import type { CompleterOptions } from '../src/terminal-complete.js';
import type { TermSession } from '../src/terminal.js';

const FAST: CompleterOptions = { settleMs: 30, maxMs: 200, graceMs: 20, resizeMs: 10 };
const SIZE = { cols: 48, rows: 20 };

interface FakeSession extends TermSession {
  readonly writes: string[];
  readonly resizes: [number, number][];
}

function fakeSession(mode: 'pty' | 'pipe' = 'pty'): FakeSession {
  const writes: string[] = [];
  const resizes: [number, number][] = [];
  return {
    mode,
    writes,
    resizes,
    write: (d: string) => { writes.push(d); },
    resize: (c: number, r: number) => { resizes.push([c, r]); },
    onData: () => {},
    onExit: () => {},
    kill: () => {},
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a pty dance writes the line plus tab, captures the echo, then kills the line', async () => {
  const session = fakeSession();
  const completer = createCompleter(session, FAST, 'darwin');

  const pending = completer.complete('ls fo', SIZE);
  await sleep(FAST.resizeMs + 5);
  // The shell echoes; the transcript must never see it.
  assert.equal(completer.filter('ls foo.txt '), null);
  const reply = await pending;

  assert.equal(reply.status, 'ok');
  assert.equal(reply.raw, 'ls foo.txt ');
  assert.equal(reply.shell, 'posix');
  assert.deepEqual(session.writes, ['ls fo\t', '\x15\x15']);
  // The pty is widened so the echo cannot soft-wrap, then narrowed back.
  assert.deepEqual(session.resizes, [[400, SIZE.rows], [SIZE.cols, SIZE.rows]]);
});

test('a silent shell hits the ceiling, returns empty, and still gets the kill-line', async () => {
  const session = fakeSession();
  const completer = createCompleter(session, FAST, 'darwin');

  const started = Date.now();
  const reply = await completer.complete('ls zz', SIZE);

  assert.equal(reply.status, 'ok');
  assert.equal(reply.raw, '');
  assert.ok(Date.now() - started >= FAST.maxMs);
  // The empty-buffer invariant holds even when nothing came back.
  assert.deepEqual(session.writes, ['ls zz\t', '\x15\x15']);
});

test('output outside a dance passes through the filter untouched', () => {
  const completer = createCompleter(fakeSession(), FAST, 'darwin');
  assert.equal(completer.filter('normal output'), 'normal output');
});

test('a piped shell is refused as unsupported and never written to', async () => {
  const session = fakeSession('pipe');
  const completer = createCompleter(session, FAST, 'darwin');
  const reply = await completer.complete('ls fo', SIZE);
  assert.equal(reply.status, 'unsupported');
  assert.deepEqual(session.writes, []);
});

test('a second dance while one is in flight is refused as busy', async () => {
  const session = fakeSession();
  const completer = createCompleter(session, FAST, 'darwin');
  const first = completer.complete('ls a', SIZE);
  const second = await completer.complete('ls b', SIZE);
  assert.equal(second.status, 'busy');
  await first;
});

test('keystrokes during a dance are held and flushed afterwards, in order', async () => {
  const session = fakeSession();
  const completer = createCompleter(session, FAST, 'darwin');

  const pending = completer.complete('ls fo', SIZE);
  await sleep(FAST.resizeMs + 5);
  completer.filter('ls foo/');
  // A user hitting Run mid-dance must not execute against the shell's
  // half-completed line.
  completer.write('echo hi\r');
  const reply = await pending;

  assert.equal(reply.status, 'ok');
  assert.deepEqual(session.writes, ['ls fo\t', '\x15\x15', 'echo hi\r']);
  // And afterwards writes flow straight through again.
  completer.write('x');
  assert.equal(session.writes[session.writes.length - 1], 'x');
});

test('windows cleans up with Escape and reports its shell family', async () => {
  const session = fakeSession();
  const completer = createCompleter(session, FAST, 'win32');

  const pending = completer.complete('Get-Ch', SIZE);
  await sleep(FAST.resizeMs + 5);
  completer.filter('Get-ChildItem');
  const reply = await pending;

  assert.equal(reply.shell, 'windows');
  assert.deepEqual(session.writes, ['Get-Ch\t', '\x1b\x1b']);
});

test('echo arriving during the post-cleanup grace is absorbed, not forwarded', async () => {
  // The kill-line's own redraw arrives right after the cleanup bytes go out;
  // probing from inside write() pins the timing instead of racing timers.
  const writes: string[] = [];
  const probed: (string | null)[] = [];
  const holder: { completer?: ReturnType<typeof createCompleter> } = {};
  const session: TermSession = {
    mode: 'pty',
    write: (d: string) => {
      writes.push(d);
      if (d === '\x15\x15' && holder.completer) probed.push(holder.completer.filter('\x1b[K'));
    },
    resize: () => {},
    onData: () => {},
    onExit: () => {},
    kill: () => {},
  };
  holder.completer = createCompleter(session, FAST, 'darwin');

  const pending = holder.completer.complete('ls fo', SIZE);
  await sleep(FAST.resizeMs + 5);
  holder.completer.filter('ls foo/');
  await pending;
  assert.deepEqual(probed, [null]);
});

test('the capture is capped so a runaway program cannot balloon the reply', async () => {
  const session = fakeSession();
  const completer = createCompleter(session, FAST, 'darwin');

  const pending = completer.complete('yes', SIZE);
  await sleep(FAST.resizeMs + 5);
  for (let i = 0; i < 80; i += 1) completer.filter('x'.repeat(1024));
  const reply = await pending;

  assert.equal(reply.status, 'ok');
  assert.ok((reply.raw ?? '').length <= 32 * 1024);
});

test('sanitize: strips control bytes that would execute instead of complete', () => {
  assert.equal(sanitizeCompletionLine('ls fo\r'), 'ls fo');
  assert.equal(sanitizeCompletionLine('ls\x03 fo'), 'ls fo');
  assert.equal(sanitizeCompletionLine('ls fo'), 'ls fo');
});

test('sanitize: refuses non-strings, empties and over-long lines', () => {
  assert.equal(sanitizeCompletionLine(42), null);
  assert.equal(sanitizeCompletionLine(''), null);
  assert.equal(sanitizeCompletionLine('\r\n'), null);
  assert.equal(sanitizeCompletionLine('x'.repeat(3000)), null);
});
