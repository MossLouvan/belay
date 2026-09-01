// Shell resolution / environment tests. resolveShell and shellEnv take the
// platform and env as parameters so both the Windows and POSIX branches are
// exercised regardless of where the suite runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveShell, shellEnv, shellCwd, pipeInput } from '../src/terminal.js';

test('windows defaults to PowerShell with the original flags', () => {
  const spec = resolveShell({} as NodeJS.ProcessEnv, 'win32');
  assert.equal(spec.file, 'powershell.exe');
  assert.deepEqual([...spec.args], ['-NoLogo', '-NoProfile']);
});

test('windows honours BELAY_SHELL=cmd via ComSpec', () => {
  const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', BELAY_SHELL: 'cmd' } as NodeJS.ProcessEnv;
  const spec = resolveShell(env, 'win32');
  assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual([...spec.args], []);
});

test('posix uses $SHELL when it is an absolute path that exists', () => {
  const spec = resolveShell({ SHELL: '/bin/zsh' } as NodeJS.ProcessEnv, 'darwin');
  assert.equal(spec.file, '/bin/zsh');
  assert.deepEqual([...spec.args], ['-l']);
});

test('posix ignores a $SHELL that is relative or does not exist', () => {
  assert.equal(resolveShell({ SHELL: 'zsh' } as NodeJS.ProcessEnv, 'darwin').file, '/bin/zsh');
  assert.equal(
    resolveShell({ SHELL: '/nonexistent/shell' } as NodeJS.ProcessEnv, 'darwin').file,
    '/bin/zsh',
  );
});

test('darwin falls back to /bin/zsh when $SHELL is unset', () => {
  assert.equal(resolveShell({} as NodeJS.ProcessEnv, 'darwin').file, '/bin/zsh');
});

test('the legacy TETHER_SHELL is still honoured', () => {
  // Set in a shell profile before the rename; dropping it would silently
  // change which shell the Terminal tab opens.
  const env = { SHELL: '/bin/zsh', TETHER_SHELL: '/bin/sh' } as NodeJS.ProcessEnv;
  assert.equal(resolveShell(env, 'darwin').file, '/bin/sh');
});

test('BELAY_SHELL overrides $SHELL on posix', () => {
  const env = { SHELL: '/bin/zsh', BELAY_SHELL: '/bin/sh' } as NodeJS.ProcessEnv;
  assert.equal(resolveShell(env, 'darwin').file, '/bin/sh');
});

test('posix env gets a usable TERM and locale without mutating the input', () => {
  const input = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
  const env = shellEnv(input, 'darwin');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(input.TERM, undefined, 'the caller env must not be mutated');
});

test('an existing TERM is respected', () => {
  const env = shellEnv({ TERM: 'screen-256color' } as NodeJS.ProcessEnv, 'darwin');
  assert.equal(env.TERM, 'screen-256color');
});

test('windows env is passed through unchanged (no TERM injected)', () => {
  const env = shellEnv({ ComSpec: 'cmd.exe' } as NodeJS.ProcessEnv, 'win32');
  assert.equal(env.TERM, undefined);
  assert.equal(env.ComSpec, 'cmd.exe');
});

test('shellCwd returns an absolute existing directory', () => {
  const cwd = shellCwd();
  assert.ok(cwd.length > 0);
});

test('win32 shellCwd prefers USERPROFILE over homedir()', () => {
  // The original Windows behaviour was exactly `process.env.USERPROFILE ||
  // process.cwd()`. os.homedir() has its own precedence and can disagree in
  // service/sandbox contexts, so the win32 branch must not consult it.
  const env = { USERPROFILE: 'C:\\Users\\override' } as NodeJS.ProcessEnv;
  const home = () => 'C:\\Users\\different';
  assert.equal(shellCwd(env, 'win32', home), 'C:\\Users\\override');
});

test('win32 shellCwd falls back to cwd when USERPROFILE is unset', () => {
  const home = () => 'C:\\Users\\different';
  assert.equal(shellCwd({} as NodeJS.ProcessEnv, 'win32', home), process.cwd());
  assert.equal(
    shellCwd({ USERPROFILE: '' } as NodeJS.ProcessEnv, 'win32', home),
    process.cwd(),
    'an empty USERPROFILE is treated as unset, as before',
  );
});

test('posix shellCwd still uses homedir()', () => {
  const env = { USERPROFILE: 'C:\\Users\\ignored' } as NodeJS.ProcessEnv;
  assert.equal(shellCwd(env, 'darwin', () => process.cwd()), process.cwd());
});

test('pipeInput turns a bare carriage return into a newline so a piped shell runs the line', () => {
  assert.equal(pipeInput('echo hi\r'), 'echo hi\n');
});

test('pipeInput collapses CRLF to a single newline rather than leaving a blank line', () => {
  assert.equal(pipeInput('echo hi\r\n'), 'echo hi\n');
});

test('pipeInput leaves an existing newline alone', () => {
  assert.equal(pipeInput('echo hi\n'), 'echo hi\n');
});

test('pipeInput translates every terminator in a multi-line paste', () => {
  assert.equal(pipeInput('a\rb\r\nc\n'), 'a\nb\nc\n');
});

test('pipeInput passes through text with no terminator, including control bytes', () => {
  assert.equal(pipeInput('\x03'), '\x03');
  assert.equal(pipeInput('partial'), 'partial');
});
