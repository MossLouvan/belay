#!/usr/bin/env node
// `npx belay-host` — start the Belay host with no checkout.
//
// The native screen/input helper is compiled on this machine on first run
// (there are no prebuilt binaries in the package: shipping unsigned ones is
// worse than a ten-second compile). Then the compiled server starts, with the
// same environment knobs as `npm start` from a checkout.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// `belay-host attach <session-id>` joins a phone-started agent session from
// this keyboard (same as `npm run attach` in a checkout). It needs no helper.
if (process.argv[2] === 'attach') {
  process.argv.splice(2, 1);
  await import('../dist/agent-attach-cli.js');
} else {
  await start();
}

async function start() {
  const nativeDir = join(root, 'native');

  const helpers = {
    darwin: {
      built: ['BelayHostMac', 'TetherHostMac'],
      build: ['/bin/bash', [join(nativeDir, 'build-mac.sh')]],
      instruction: 'Install the Xcode command line tools (xcode-select --install) and run belay-host again.',
    },
    win32: {
      built: ['BelayHost.exe', 'TetherHost.exe'],
      build: ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(nativeDir, 'build.ps1')]],
      instruction: 'Install the .NET Framework developer pack (csc.exe) and run belay-host again.',
    },
  }[process.platform];

  if (helpers && !helpers.built.some((f) => existsSync(join(nativeDir, f)))) {
    console.log('[belay-host] building the native screen/input helper (first run only)...');
    const [cmd, args] = helpers.build;
    const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: nativeDir });
    if (result.status !== 0) {
      console.error(`[belay-host] the native helper did not build. ${helpers.instruction}`);
      console.error('[belay-host] starting without it: terminal and files work, the Screen tab will not.');
    }
  }

  await import('../dist/index.js');
}
