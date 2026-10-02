// Stage the host agent for packaging: desktop/host/ becomes Resources/host in
// the app (electron-builder extraResources, see package.json "build").
//
//   host/package.json     "type": "module", so dist/*.js loads as ESM
//   host/dist/            server/ compiled by tsc
//   host/dist/node_modules/ production deps only, no optional (node-pty is
//                         built for the system Node's ABI, not Electron's —
//                         the host falls back to a piped shell without it)
//   host/native/          the prebuilt helper(s): BelayHostMac (universal,
//                         from server/native/build-mac.sh) and/or BelayHost.exe
//   host/scripts/         the autostart scripts, kept so /autostart's legacy
//                         path still resolves (unused under the app)
//
// Run from desktop/: `npm run stage`. Needs the helper already built; it
// never compiles Swift or C# itself, that is CI's or the owner's job.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(desktop, '..', 'server');
const out = join(desktop, 'host');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('npm', ['run', 'build'], server);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'native'), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) cpSync(join(server, file), join(out, file));
cpSync(join(server, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(server, 'scripts'), join(out, 'scripts'), { recursive: true });
run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], out);
// Under dist/, not at the root: electron-builder drops a root-level
// node_modules from an extraResources tree (app-builder-lib util/filter.js),
// and dist/index.js resolves dist/node_modules first anyway.
renameSync(join(out, 'node_modules'), join(out, 'dist', 'node_modules'));

const helpers = ['BelayHostMac', 'TetherHostMac', 'BelayHost.exe', 'TetherHost.exe'];
const staged = helpers.filter((name) => existsSync(join(server, 'native', name)));
for (const name of staged) cpSync(join(server, 'native', name), join(out, 'native', name));
if (staged.length === 0) {
  console.error('[stage] no native helper in server/native — build it first (bash native/build-mac.sh or native/build.ps1).');
  console.error('[stage] staging without it: the app will run, but Screen and input will be off.');
}
console.log(`[stage] ${out} ready (helpers: ${staged.join(', ') || 'none'})`);
