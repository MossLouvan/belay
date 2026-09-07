// Tests for merging Belay's hook entries into a Claude Code settings
// document: idempotent, never clobbers the user's own hooks, reversible.
// The file round trip runs against a temp HOME — the real
// ~/.claude/settings.json is never opened here. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  belayHookGroups, hooksStatusLine, installedEvents, isBelayHook, mergeHooks, removeHooks,
} from '../src/hooks-install.js';
import type { JsonObject } from '../src/hooks-install.js';
import { runHooksInstall, settingsPath } from '../src/hooks-install-cli.js';

const OPTS = { scriptPath: '/repo/server/hooks/belay-hook.mjs', port: 8787, node: '/usr/local/bin/node' };
const USER_HOOK = { type: 'command', command: 'echo user-hook' };

const userSettings = (): JsonObject => ({
  permissions: { defaultMode: 'auto' },
  model: 'opus',
  hooks: {
    PermissionRequest: [{ hooks: [USER_HOOK] }],
    PostToolUse: [{ matcher: 'Write', hooks: [USER_HOOK] }],
  },
});

// ---- pure merge ------------------------------------------------------------

test('belayHookGroups: PermissionRequest is sync with a spinner text; the rest are async', () => {
  const g = belayHookGroups(OPTS);
  assert.equal(g.PermissionRequest.hooks[0].async, undefined);
  assert.equal(g.PermissionRequest.hooks[0].timeout, 600);
  assert.match(g.PermissionRequest.hooks[0].statusMessage ?? '', /phone/);
  assert.deepEqual(g.PermissionRequest.hooks[0].args, ['/repo/server/hooks/belay-hook.mjs', '--port', '8787']);
  assert.equal(g.PermissionRequest.hooks[0].command, '/usr/local/bin/node');
  assert.equal(g.Notification.matcher, 'permission_prompt');
  for (const e of ['Notification', 'Stop', 'SessionStart'] as const) assert.equal(g[e].hooks[0].async, true);
});

test('isBelayHook recognises our script in exec and shell form, nothing else', () => {
  assert.equal(isBelayHook({ type: 'command', command: 'node', args: ['/x/belay-hook.mjs'] }), true);
  assert.equal(isBelayHook({ type: 'command', command: 'node "/x/belay-hook.mjs" --port 1' }), true);
  assert.equal(isBelayHook(USER_HOOK), false);
  assert.equal(isBelayHook('junk'), false);
});

test('mergeHooks adds four events and keeps every other key and hook intact', () => {
  const before = userSettings();
  const { settings, changes, changed } = mergeHooks(before, OPTS);
  assert.equal(changed, true);
  assert.deepEqual(changes, ['PermissionRequest: added', 'Notification: added', 'Stop: added', 'SessionStart: added']);
  assert.deepEqual(settings.permissions, { defaultMode: 'auto' });
  assert.equal(settings.model, 'opus');
  const hooks = settings.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.PostToolUse, [{ matcher: 'Write', hooks: [USER_HOOK] }]);
  // The user's own PermissionRequest hook comes first, ours after it.
  assert.equal(hooks.PermissionRequest.length, 2);
  assert.deepEqual(hooks.PermissionRequest[0], { hooks: [USER_HOOK] });
  assert.equal(isBelayHook((hooks.PermissionRequest[1] as { hooks: unknown[] }).hooks[0]), true);
  // The input was not mutated.
  assert.equal((before.hooks as Record<string, unknown[]>).PermissionRequest.length, 1);
});

test('mergeHooks is idempotent: a second run changes nothing and says so', () => {
  const once = mergeHooks(userSettings(), OPTS);
  const twice = mergeHooks(once.settings, OPTS);
  assert.equal(twice.changed, false);
  assert.equal(twice.settings, once.settings);
  assert.deepEqual(twice.changes, ['PermissionRequest: unchanged', 'Notification: unchanged', 'Stop: unchanged', 'SessionStart: unchanged']);
});

test('mergeHooks with a new port replaces the old entry instead of stacking a second', () => {
  const once = mergeHooks(userSettings(), OPTS);
  const moved = mergeHooks(once.settings, { ...OPTS, port: 9999 });
  assert.equal(moved.changed, true);
  assert.equal(moved.changes[0], 'PermissionRequest: replaced');
  const hooks = moved.settings.hooks as Record<string, { hooks: { args?: string[] }[] }[]>;
  assert.equal(hooks.PermissionRequest.length, 2);
  assert.deepEqual(hooks.PermissionRequest[1].hooks[0].args?.slice(-1), ['9999']);
  assert.equal(hooks.Stop.length, 1);
});

test('mergeHooks replaces our hook inside a mixed group without touching its neighbour', () => {
  const mixed: JsonObject = {
    hooks: { Stop: [{ hooks: [USER_HOOK, { type: 'command', command: 'node', args: ['/old/belay-hook.mjs'] }] }] },
  };
  const { settings } = mergeHooks(mixed, OPTS);
  const stop = (settings.hooks as { Stop: { hooks: unknown[] }[] }).Stop;
  assert.deepEqual(stop[0], { hooks: [USER_HOOK] });
  assert.equal(stop.length, 2);
});

test('removeHooks takes ours out, leaves the user\'s, and drops empty containers', () => {
  const installed = mergeHooks(userSettings(), OPTS).settings;
  const { settings, changed, changes } = removeHooks(installed);
  assert.equal(changed, true);
  assert.deepEqual(changes, ['PermissionRequest: removed', 'Notification: removed', 'Stop: removed', 'SessionStart: removed']);
  assert.deepEqual(settings, userSettings());
  // A document that was only ours ends with no `hooks` key at all.
  const onlyOurs = mergeHooks({ model: 'opus' }, OPTS).settings;
  assert.deepEqual(removeHooks(onlyOurs).settings, { model: 'opus' });
  // Nothing to remove: unchanged, same object.
  const clean = userSettings();
  assert.equal(removeHooks(clean).settings, clean);
});

test('installedEvents and hooksStatusLine describe none / partial / all', () => {
  assert.deepEqual(installedEvents(userSettings()), []);
  assert.match(hooksStatusLine(userSettings()), /not installed/);
  const full = mergeHooks(userSettings(), OPTS).settings;
  assert.equal(installedEvents(full).length, 4);
  assert.match(hooksStatusLine(full), /installed .*4 events/);
  const partial = { hooks: { Stop: [belayHookGroups(OPTS).Stop] } };
  assert.match(hooksStatusLine(partial), /partially installed \(Stop\)/);
  assert.match(hooksStatusLine(null), /not installed/);
});

// ---- file round trip against a temp HOME -----------------------------------

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'belay-hooks-'));
}

test('install writes a backup and the merged file; a second install writes nothing', () => {
  const home = tempHome();
  const path = settingsPath(home);
  mkdirSync(join(home, '.claude'));
  writeFileSync(path, JSON.stringify(userSettings(), null, 2));
  let t = 100;
  const first = runHooksInstall({ action: 'install', home, ...OPTS, now: () => t++ });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.backupPath, `${path}.belay-backup-100`);
  assert.deepEqual(JSON.parse(readFileSync(first.backupPath!, 'utf8')), userSettings());
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(installedEvents(written).length, 4);
  assert.equal(written.model, 'opus');

  const second = runHooksInstall({ action: 'install', home, ...OPTS, now: () => t++ });
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, undefined);
  assert.equal(readdirSync(join(home, '.claude')).filter((f) => f.includes('backup')).length, 1);

  const status = runHooksInstall({ action: 'status', home });
  assert.match(status.lines[0], /installed .*4 events/);

  const removed = runHooksInstall({ action: 'uninstall', home, now: () => t++ });
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), userSettings());
  assert.equal(runHooksInstall({ action: 'uninstall', home }).changed, false);
});

test('install with no settings file creates one; a broken file is left alone', () => {
  const home = tempHome();
  const out = runHooksInstall({ action: 'install', home, ...OPTS });
  assert.equal(out.ok, true);
  assert.equal(out.backupPath, undefined);
  assert.equal(installedEvents(JSON.parse(readFileSync(settingsPath(home), 'utf8'))).length, 4);

  const broken = tempHome();
  mkdirSync(join(broken, '.claude'));
  writeFileSync(settingsPath(broken), '{ not json');
  const bad = runHooksInstall({ action: 'install', home: broken, ...OPTS });
  assert.equal(bad.ok, false);
  assert.equal(readFileSync(settingsPath(broken), 'utf8'), '{ not json');
  assert.equal(existsSync(`${settingsPath(broken)}.belay-backup-0`), false);
});
