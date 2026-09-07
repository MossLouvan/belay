// `npm run hooks:install` / `npm run hooks:uninstall`: put Belay's hook
// entries into ~/.claude/settings.json, or take them out. The file I/O lives
// here; what the new document should be is hooks-install.ts's business.
//
// Careful with a file that is not ours: it is backed up before every write,
// re-serialised with the same two-space indent Claude Code uses, and never
// written when nothing would change. A settings.json that does not parse is
// left exactly as it is, with the error explained — a broken file is the
// user's to fix, not ours to overwrite.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { productEnv } from './env.js';
import { hooksStatusLine, mergeHooks, removeHooks } from './hooks-install.js';
import type { JsonObject } from './hooks-install.js';

export type InstallAction = 'install' | 'uninstall' | 'status';

export interface InstallRun {
  readonly action: InstallAction;
  readonly home?: string;
  readonly port?: number;
  readonly scriptPath?: string;
  readonly node?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface InstallOutcome {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly settingsPath: string;
  readonly backupPath?: string;
  readonly lines: readonly string[];
}

const DEFAULT_PORT = 8787;

export function settingsPath(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json');
}

/** The script the repo ships, resolved from this file's own location. */
export function defaultScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'belay-hook.mjs');
}

/** Read and parse the user's settings; a missing file is an empty document. */
export function readSettings(path: string): { ok: true; settings: JsonObject } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, settings: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'settings.json is not a JSON object' };
    return { ok: true, settings: parsed as JsonObject };
  } catch (e) {
    return { ok: false, error: `settings.json does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function writeWithBackup(path: string, settings: JsonObject, now: () => number): string | undefined {
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.belay-backup-${now()}`;
    copyFileSync(path, backup);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return backup;
}

/** Run one action end to end; every line for the user comes back in `lines`. */
export function runHooksInstall(run: InstallRun): InstallOutcome {
  const path = settingsPath(run.home);
  const read = readSettings(path);
  if (!read.ok) return { ok: false, changed: false, settingsPath: path, lines: [read.error, 'Nothing was written.'] };

  if (run.action === 'status') {
    return { ok: true, changed: false, settingsPath: path, lines: [hooksStatusLine(read.settings)] };
  }
  const result = run.action === 'install'
    ? mergeHooks(read.settings, {
      scriptPath: run.scriptPath ?? defaultScriptPath(),
      port: run.port ?? DEFAULT_PORT,
      node: run.node,
    })
    : removeHooks(read.settings);
  if (!result.changed) {
    return { ok: true, changed: false, settingsPath: path, lines: [...result.changes, `${path} already up to date; nothing written.`] };
  }
  const backupPath = writeWithBackup(path, result.settings, run.now ?? Date.now);
  const lines = [
    ...result.changes,
    `wrote ${path}`,
    ...(backupPath ? [`backup at ${backupPath}`] : []),
    ...(run.action === 'install'
      ? ['Restart any running `claude` session for it to pick the hooks up.']
      : []),
  ];
  return { ok: true, changed: true, settingsPath: path, backupPath, lines };
}

function actionFromArgv(argv: readonly string[]): InstallAction | null {
  const a = argv[0];
  return a === 'install' || a === 'uninstall' || a === 'status' ? a : null;
}

function main(): void {
  const action = actionFromArgv(process.argv.slice(2));
  if (!action) {
    console.error('usage: hooks-install-cli <install|uninstall|status>');
    process.exit(2);
  }
  const portRaw = Number(productEnv('PORT'));
  const outcome = runHooksInstall({
    action,
    port: Number.isInteger(portRaw) && portRaw > 0 ? portRaw : DEFAULT_PORT,
    // The exact node running this command, so the hook does not depend on
    // whatever `node` Claude Code's spawn environment happens to find.
    node: process.execPath,
  });
  for (const line of outcome.lines) console.log(`  ${line}`);
  process.exit(outcome.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
