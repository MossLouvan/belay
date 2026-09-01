// The handoff builds shell-adjacent strings from user-influenced data and
// decides when a terminal may attach to a session the phone might still be
// driving — so these tests lead with quoting under hostile paths, then the
// detection fallbacks, then the busy/stop protocol. No test here ever spawns
// a process: every launch goes through an injected exec that only records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claudeArgv, createHandoffHandler, detectTerminal, isClaudeSessionId,
  launchPlan, posixQuote, readClaudeSessionId, resumeCommand,
} from '../src/handoff.js';
import type { HandoffDeps, TerminalApp } from '../src/handoff.js';

const CLAUDE_ID = 'abcdef01-2345-6789-abcd-ef0123456789';

// ---- command construction -------------------------------------------------

test('posixQuote survives spaces, double quotes, and embedded single quotes', () => {
  assert.equal(posixQuote('/Users/me/My Projects'), `'/Users/me/My Projects'`);
  assert.equal(posixQuote(`/tmp/say "hi"`), `'/tmp/say "hi"'`);
  // ' closes the quote, escapes the quote char, reopens — the classic dance.
  assert.equal(posixQuote(`/tmp/it's here`), `'/tmp/it'\\''s here'`);
});

test('resumeCommand quotes the path and validates the id on darwin', () => {
  const cmd = resumeCommand(`/Users/me/My "odd" project`, CLAUDE_ID, 'darwin');
  assert.equal(cmd, `cd '/Users/me/My "odd" project' && claude --resume ${CLAUDE_ID}`);
});

test('resumeCommand without a claude id starts a fresh claude in the project', () => {
  assert.equal(resumeCommand('/Users/me/proj', undefined, 'darwin'), `cd '/Users/me/proj' && claude`);
});

test('a non-uuid session id never reaches the command line', () => {
  const cmd = resumeCommand('/p', '$(rm -rf ~)', 'darwin');
  assert.equal(cmd, `cd '/p' && claude`);
  assert.deepEqual(claudeArgv('; shutdown'), ['claude']);
});

test('resumeCommand on windows uses cd /d and strips illegal quotes', () => {
  const cmd = resumeCommand(`C:\\Users\\me\\My "Projects"`, CLAUDE_ID, 'win32');
  assert.equal(cmd, `cd /d "C:\\Users\\me\\My Projects" && claude --resume ${CLAUDE_ID}`);
});

test('isClaudeSessionId accepts the uuid grammar and nothing else', () => {
  assert.ok(isClaudeSessionId(CLAUDE_ID));
  assert.ok(!isClaudeSessionId(`${CLAUDE_ID} extra`));
  assert.ok(!isClaudeSessionId(''));
  assert.ok(!isClaudeSessionId(42));
});

// ---- terminal detection ---------------------------------------------------

test('darwin prefers iTerm when installed, Terminal otherwise', () => {
  const withITerm = { exists: (p: string) => p === '/Applications/iTerm.app', which: () => null };
  assert.equal(detectTerminal('darwin', withITerm), 'iTerm');
  const without = { exists: () => false, which: () => null };
  assert.equal(detectTerminal('darwin', without), 'Terminal');
});

test('windows prefers Windows Terminal, falls back to cmd, and never probes files', () => {
  const withWt = { exists: () => { throw new Error('should not stat'); }, which: () => 'C:\\wt.exe' };
  assert.equal(detectTerminal('win32', withWt), 'Windows Terminal');
  const without = { exists: () => false, which: () => null };
  assert.equal(detectTerminal('win32', without), 'cmd');
});

test('an unknown platform has no terminal answer', () => {
  assert.equal(detectTerminal('linux', { exists: () => true, which: () => '/usr/bin/wt' }), null);
});

// ---- launch plans ---------------------------------------------------------

test('mac plans carry the shell line as an osascript argument, not in the script', () => {
  for (const app of ['iTerm', 'Terminal'] as const) {
    const plan = launchPlan(app, '/Users/me/My Projects/app', CLAUDE_ID);
    assert.equal(plan.file, 'osascript');
    assert.equal(plan.args[0], '-e');
    // The script itself must never contain the path — it reads argv instead.
    assert.ok(String(plan.args[1]).includes('on run argv'));
    assert.ok(!String(plan.args[1]).includes('My Projects'));
    assert.equal(plan.args[2], `cd '/Users/me/My Projects/app' && claude --resume ${CLAUDE_ID}`);
  }
});

test('windows terminal plan passes the directory and claude tokens as argv', () => {
  const plan = launchPlan('Windows Terminal', 'C:\\My Projects\\app', CLAUDE_ID);
  assert.equal(plan.file, 'wt.exe');
  assert.deepEqual(plan.args, ['-d', 'C:\\My Projects\\app', 'cmd', '/k', 'claude', '--resume', CLAUDE_ID]);
  assert.equal(plan.cwd, undefined);
});

test('cmd fallback keeps the path out of the arg list entirely', () => {
  const plan = launchPlan('cmd', 'C:\\My Projects\\app', undefined);
  assert.equal(plan.file, 'cmd.exe');
  assert.deepEqual(plan.args, ['/c', 'start', 'Claude Code', 'cmd', '/k', 'claude']);
  assert.equal(plan.cwd, 'C:\\My Projects\\app');
});

// ---- meta reading ---------------------------------------------------------

test('readClaudeSessionId finds the recorded id and shrugs at garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-handoff-'));
  const file = join(dir, 'belay-agent.json');
  writeFileSync(file, JSON.stringify({
    sessions: [
      { id: 't1', claudeSessionId: CLAUDE_ID },
      { id: 't2' },
      { id: 't3', claudeSessionId: 'not-a-uuid' },
    ],
  }));
  assert.equal(readClaudeSessionId('t1', file), CLAUDE_ID);
  assert.equal(readClaudeSessionId('t2', file), undefined);
  assert.equal(readClaudeSessionId('t3', file), undefined);
  assert.equal(readClaudeSessionId('t1', join(dir, 'missing.json')), undefined);
  writeFileSync(file, 'not json');
  assert.equal(readClaudeSessionId('t1', file), undefined);
});

// ---- the handler protocol -------------------------------------------------

interface FakeRes {
  code: number;
  body: any;
}

function fakeRes(): FakeRes & { status: (c: number) => any; json: (b: any) => void } {
  const r: any = { code: 200, body: undefined };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: any) => { r.body = b; };
  return r;
}

function fakeDeps(overrides: Partial<HandoffDeps> & { status?: string }): HandoffDeps & {
  stopped: string[]; launched: { file: string; args: readonly string[]; cwd?: string }[];
} {
  const stopped: string[] = [];
  const launched: { file: string; args: readonly string[]; cwd?: string }[] = [];
  return {
    stopped,
    launched,
    getSnapshot: ((id: string) => ({ id, title: 't', cwd: '/Users/me/My Projects/app', status: overrides.status ?? 'idle' })) as any,
    stopSession: (id: string) => { stopped.push(id); },
    readClaudeSessionId: () => CLAUDE_ID,
    detect: () => 'Terminal' as TerminalApp,
    exec: async (file, args, options) => { launched.push({ file, args, cwd: options.cwd }); },
    platform: 'darwin',
    ...overrides,
  };
}

const req = (id: string, body: object = {}) => ({ params: { id }, body }) as any;

test('unknown session is 404 and nothing is stopped or launched', async () => {
  const deps = fakeDeps({ getSnapshot: () => null as any });
  const res = fakeRes();
  await createHandoffHandler(deps)(req('nope'), res as any);
  assert.equal(res.code, 404);
  assert.deepEqual(deps.stopped, []);
  assert.deepEqual(deps.launched, []);
});

test('a running session is refused without stop:true — and untouched', async () => {
  const deps = fakeDeps({ status: 'running' });
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1'), res as any);
  assert.equal(res.code, 409);
  assert.equal(res.body.busy, true);
  assert.equal(res.body.status, 'running');
  // The command still rides along so the app can offer copy-paste instead.
  assert.match(res.body.command, /claude --resume/);
  assert.deepEqual(deps.stopped, []);
  assert.deepEqual(deps.launched, []);
});

test('a waiting session (pending approval) counts as busy too', async () => {
  const deps = fakeDeps({ status: 'waiting' });
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1'), res as any);
  assert.equal(res.code, 409);
});

test('stop:true on a busy session stops the phone side before launching', async () => {
  const events: string[] = [];
  const deps = fakeDeps({ status: 'running' });
  const origStop = deps.stopSession;
  (deps as any).stopSession = (id: string) => { events.push('stop'); origStop(id); };
  (deps as any).exec = async () => { events.push('launch'); };
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1', { stop: true }), res as any);
  assert.equal(res.code, 200);
  assert.equal(res.body.opened, true);
  assert.equal(res.body.stopped, true);
  assert.deepEqual(events, ['stop', 'launch']); // never both clients at once
});

test('an idle session is released too — the lingering idle child must die first', async () => {
  const deps = fakeDeps({});
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1'), res as any);
  assert.equal(res.body.opened, true);
  assert.equal(res.body.terminal, 'Terminal');
  assert.equal(res.body.stopped, false);
  assert.deepEqual(deps.stopped, ['s1']);
  assert.equal(deps.launched.length, 1);
});

test('no terminal on this machine falls back to the copyable command', async () => {
  const deps = fakeDeps({ detect: () => null });
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1'), res as any);
  assert.equal(res.code, 200);
  assert.equal(res.body.opened, false);
  assert.equal(res.body.command, `cd '/Users/me/My Projects/app' && claude --resume ${CLAUDE_ID}`);
  assert.ok(res.body.reason);
  assert.deepEqual(deps.launched, []);
});

test('a failed launch degrades to the command, not to an error', async () => {
  const deps = fakeDeps({ exec: async () => { throw new Error('osascript: not allowed'); } });
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1'), res as any);
  assert.equal(res.code, 200);
  assert.equal(res.body.opened, false);
  assert.match(res.body.command, /claude --resume/);
});

test('a session with no claude history opens plain claude in the project', async () => {
  const deps = fakeDeps({ readClaudeSessionId: () => undefined });
  const res = fakeRes();
  await createHandoffHandler(deps)(req('s1'), res as any);
  assert.equal(res.body.opened, true);
  assert.equal(res.body.command, `cd '/Users/me/My Projects/app' && claude`);
  assert.equal(deps.launched[0].args[2], `cd '/Users/me/My Projects/app' && claude`);
});
