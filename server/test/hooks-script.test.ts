// Tests for hooks/belay-hook.mjs, the process Claude Code actually runs: it
// is spawned for real with a JSON event on stdin, against a fake host on
// loopback and a temp HOME holding the secret. What matters is its stdout
// (the only thing Claude Code reads) and that it exits 0 no matter what.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SCRIPT = resolve(import.meta.dirname, '..', 'hooks', 'belay-hook.mjs');
const SECRET = 'c'.repeat(64);

function homeWithSecret(secret: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'belay-hook-home-'));
  if (secret !== null) {
    mkdirSync(join(home, '.belay'));
    writeFileSync(join(home, '.belay', 'hook-secret'), `${secret}\n`);
  }
  return home;
}

interface Seen { readonly event: string; readonly secret: string | undefined; readonly body: unknown }

async function fakeHost(answer: unknown): Promise<{ port: number; seen: Seen[]; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  const seen: Seen[] = [];
  app.post('/hooks/:event', (req, res) => {
    seen.push({ event: req.params.event, secret: req.get('x-belay-hook-secret'), body: req.body });
    res.setHeader('x-belay-hook', 'test');
    res.json(answer);
  });
  const server: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function runHook(port: number, home: string, stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT, '--port', String(port)], {
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(stdin);
  });
}

const permission = JSON.stringify({
  session_id: 's', cwd: '/p', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' },
});

test('prints the host\'s decision envelope verbatim, with the secret sent', async () => {
  const decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  const host = await fakeHost(decision);
  try {
    const out = await runHook(host.port, homeWithSecret(SECRET), permission);
    assert.equal(out.code, 0);
    assert.deepEqual(JSON.parse(out.stdout), decision);
    assert.equal(host.seen.length, 1);
    assert.equal(host.seen[0].event, 'PermissionRequest');
    assert.equal(host.seen[0].secret, SECRET);
    assert.deepEqual(host.seen[0].body, JSON.parse(permission));
  } finally { await host.close(); }
});

test('an empty answer ({}) prints nothing: Claude Code shows its own prompt', async () => {
  const host = await fakeHost({});
  try {
    const out = await runHook(host.port, homeWithSecret(SECRET), permission);
    assert.equal(out.code, 0);
    assert.equal(out.stdout, '');
  } finally { await host.close(); }
});

test('a malformed decision (no behavior) is not passed through', async () => {
  const host = await fakeHost({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'maybe' } } });
  try {
    const out = await runHook(host.port, homeWithSecret(SECRET), permission);
    assert.equal(out.stdout, '');
  } finally { await host.close(); }
});

test('no secret file, host down, or a Belay-spawned session: silent exit 0, no request', async () => {
  const host = await fakeHost({});
  try {
    const noSecret = await runHook(host.port, homeWithSecret(null), permission);
    assert.equal(noSecret.code, 0);
    assert.equal(noSecret.stdout, '');
    assert.match(noSecret.stderr, /hook-secret/);

    const spawned = await runHook(host.port, homeWithSecret(SECRET), permission, { BELAY_SPAWNED: '1' });
    assert.equal(spawned.stdout, '');
    assert.equal(host.seen.length, 0);

    const garbage = await runHook(host.port, homeWithSecret(SECRET), 'not json');
    assert.equal(garbage.code, 0);
    assert.equal(garbage.stdout, '');
  } finally { await host.close(); }
  const down = await runHook(1, homeWithSecret(SECRET), permission);
  assert.equal(down.code, 0);
  assert.equal(down.stdout, '');
  assert.match(down.stderr, /unreachable/);
});

test('Stop is forwarded and prints nothing', async () => {
  const host = await fakeHost({});
  try {
    const out = await runHook(host.port, homeWithSecret(SECRET), JSON.stringify({
      session_id: 's', cwd: '/p', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok',
    }));
    assert.equal(out.stdout, '');
    assert.equal(host.seen[0]?.event, 'Stop');
  } finally { await host.close(); }
});
