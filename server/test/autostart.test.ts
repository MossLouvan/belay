// The status parser and the argv the autostart routes hand to execFile.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autostartCommand, parseAutostartStatus } from '../src/autostart.js';

test('parseAutostartStatus reads the macOS script output, pid included', () => {
  const out = ['Belay autostart: INSTALLED', '\tstate = running', '\tpid = 4242', '', 'Logs: /x'].join('\n');
  assert.deepEqual(parseAutostartStatus(out), { installed: true, pid: 4242 });
});

test('parseAutostartStatus reads the Windows script output, no pid', () => {
  const out = ['Belay autostart: INSTALLED', '  State        : Running', '  Last run     : 1/1/2026'].join('\n');
  assert.deepEqual(parseAutostartStatus(out), { installed: true });
});

test('parseAutostartStatus: not installed, even with the legacy note', () => {
  const out = 'Belay autostart: not installed\nnote: the pre-rename agent (com.tether.host) is still loaded\n';
  assert.deepEqual(parseAutostartStatus(out), { installed: false });
});

test('autostartCommand never goes through a shell and passes the action as its own argv entry', () => {
  const mac = autostartCommand('remove', 'darwin');
  assert.equal(mac?.file, '/bin/bash');
  assert.match(mac!.args[0], /scripts[\\/]autostart-macos\.sh$/);
  assert.equal(mac!.args[1], 'remove');

  const win = autostartCommand('install', 'win32');
  assert.equal(win?.file, 'powershell');
  assert.deepEqual(win!.args.slice(-2), ['-Action', 'install']);
  assert.match(win!.args[4], /autostart-windows\.ps1$/);

  assert.equal(autostartCommand('status', 'linux'), null);
});
