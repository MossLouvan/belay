// Start-at-login, driven from the phone. The plist/scheduled-task logic lives
// in scripts/autostart-macos.sh and scripts/autostart-windows.ps1 (also behind
// `npm run autostart`); this module only runs those scripts with a fixed argv
// and reads their "Belay autostart: INSTALLED" line back.
//
// The one trap: when this very process was started by the LaunchAgent/task,
// both `install` (which boots the old agent out first) and `remove` kill it —
// mid-request, before the phone gets an answer. So enable is idempotent (an
// installed agent is left alone) and disable answers first when it is about to
// take itself down.

import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, RequestHandler } from 'express';

import { messageOf } from './errors.js';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_TIMEOUT_MS = 30_000;

export type AutostartAction = 'install' | 'status' | 'remove';

export interface AutostartStatus {
  /** False on platforms with no recipe (Linux). */
  readonly supported: boolean;
  readonly installed: boolean;
  /** launchd's pid for the agent, when the status output names one (macOS). */
  readonly pid?: number;
}

/** The exact argv `npm run autostart -- <action>` would use, minus npm. */
export function autostartCommand(
  action: AutostartAction,
  plat: NodeJS.Platform = process.platform,
): { file: string; args: readonly string[] } | null {
  if (plat === 'darwin') {
    return { file: '/bin/bash', args: [resolve(SERVER_DIR, 'scripts', 'autostart-macos.sh'), action] };
  }
  if (plat === 'win32') {
    return {
      file: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        resolve(SERVER_DIR, 'scripts', 'autostart-windows.ps1'), '-Action', action],
    };
  }
  return null;
}

/** Read the scripts' status output. Both print "Belay autostart: INSTALLED" or "... not installed". */
export function parseAutostartStatus(stdout: string): Omit<AutostartStatus, 'supported'> {
  const installed = /^Belay autostart: INSTALLED/m.test(stdout);
  const pid = stdout.match(/^\s*pid = (\d+)/m);
  return pid ? { installed, pid: Number(pid[1]) } : { installed };
}

function runScript(action: AutostartAction): Promise<string> {
  const cmd = autostartCommand(action);
  if (!cmd) return Promise.reject(new Error(`autostart is not supported on ${process.platform}`));
  return new Promise((res, rej) => {
    execFile(cmd.file, [...cmd.args], { cwd: SERVER_DIR, timeout: SCRIPT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) rej(new Error((stderr || stdout || messageOf(err)).trim().split('\n').pop() || messageOf(err)));
        else res(stdout);
      });
  });
}

export async function autostartStatus(): Promise<AutostartStatus> {
  if (!autostartCommand('status')) return { supported: false, installed: false };
  return { supported: true, ...parseAutostartStatus(await runScript('status')) };
}

/** Whether removing the agent would take this very process down with it. */
function launchedByAutostart(status: AutostartStatus): boolean {
  if (!status.installed) return false;
  if (status.pid !== undefined) return status.pid === process.pid;
  // Windows' status names no pid; the task is the only thing that sets this.
  return process.env.BELAY_STATE_FILE !== undefined;
}

/** One banner line: on, off with the hint, or unsupported. */
export async function autostartBannerLine(): Promise<string> {
  try {
    const s = await autostartStatus();
    if (!s.supported) return 'not available on this platform';
    return s.installed ? 'on' : 'off — enable it from the phone or run npm run autostart';
  } catch (e: unknown) {
    return `unknown (${messageOf(e)})`;
  }
}

export function registerAutostartRoutes(app: Express, auth: RequestHandler): void {
  app.get('/autostart', auth, async (_req, res) => {
    try { res.json(await autostartStatus()); }
    catch (e: unknown) { res.status(500).json({ error: `could not read autostart status: ${messageOf(e)}` }); }
  });

  app.post('/autostart/enable', auth, async (_req, res) => {
    try {
      const before = await autostartStatus();
      if (!before.supported) { res.status(400).json({ error: `autostart is not supported on ${process.platform}` }); return; }
      // Idempotent: re-installing boots the running agent out, which would be us.
      if (before.installed) { res.json({ ok: true, installed: true }); return; }
      await runScript('install');
      res.json({ ok: true, installed: (await autostartStatus()).installed });
    } catch (e: unknown) {
      res.status(500).json({ error: `could not enable autostart: ${messageOf(e)}` });
    }
  });

  app.post('/autostart/disable', auth, async (_req, res) => {
    try {
      const before = await autostartStatus();
      if (!before.installed) { res.json({ ok: true, installed: false }); return; }
      if (launchedByAutostart(before)) {
        // Removing the agent stops this process. Answer, then go.
        res.json({ ok: true, installed: false, restarting: true });
        res.on('finish', () => {
          runScript('remove').catch((e: unknown) => console.error(`[autostart] remove failed: ${messageOf(e)}`));
        });
        return;
      }
      await runScript('remove');
      res.json({ ok: true, installed: (await autostartStatus()).installed });
    } catch (e: unknown) {
      res.status(500).json({ error: `could not disable autostart: ${messageOf(e)}` });
    }
  });
}
