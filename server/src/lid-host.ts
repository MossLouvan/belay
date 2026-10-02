// Lid-closed mode: the shell half. Runs the keep-awake commands, polls the lid
// while armed, and tells the stream when the lid state changes. Every command
// goes through an injected `exec` with an argv array, so tests script it and
// nothing here ever builds a shell string from data.
//
// macOS: `pmset -a disablesleep 1|0` needs root. The first enable installs a
// sudoers rule allowing exactly those two commands (lid-mode.ts), validated
// with `visudo -cf`, through one `osascript ... with administrator privileges`
// prompt. From then on `sudo -n` runs them without a prompt.
//
// Windows: save the lid action (powercfg LIDACTION AC/DC), set both to 0 (do
// nothing) while armed, restore after. The saved pair is persisted so a crash
// can be undone on the next start. Windows has no cheap lid probe from Node,
// so `lidClosed` is simply "armed": the virtual display stays up for the
// whole armed stream (design.md allows exactly this). UNVERIFIED on Windows.

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { messageOf } from './errors.js';
import {
  BATTERY_WARNING, PMSET, SUDOERS_PATH, SUDOERS_STAGING, lidStatus, parseClamshell, parsePowercfgLidAction,
  parseWin32Battery, sudoersRule, toLidBattery, type LidBattery, type LidStatus,
} from './lid-mode.js';
import { batteryInfo } from './osinfo.js';

const EXEC_TIMEOUT_MS = 5_000;
/** The admin prompt can sit on screen for a while. */
const PROMPT_TIMEOUT_MS = 120_000;
export const LID_POLL_MS = 2_000;

export interface LidAction { readonly ac: number; readonly dc: number }

export interface LidDeps {
  readonly platform: NodeJS.Platform;
  readonly user: string;
  readonly exec: (file: string, args: readonly string[], timeoutMs?: number) => Promise<string>;
  readonly now: () => number;
  readonly getEnabled: () => boolean;
  readonly setEnabled: (on: boolean) => void;
  readonly getSavedLidAction: () => LidAction | null;
  readonly setSavedLidAction: (v: LidAction | null) => void;
  readonly readBattery: () => Promise<LidBattery | null>;
  readonly onWarn: (message: string) => void;
  readonly log: (message: string) => void;
}

export interface LidModeStatus {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly status: LidStatus;
  readonly lidClosed: boolean;
}

export type LidReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface LidController {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): LidModeStatus;
  setEnabled(on: boolean): Promise<LidReply>;
  streamStarted(): void;
  streamEnded(): void;
  /** Called with true when the lid shuts while armed, false when it opens or arming ends. */
  subscribe(cb: (closed: boolean) => void): () => void;
  tick(): Promise<void>;
  /** Wait for in-flight arm/release work (tests). */
  settle(): Promise<void>;
}

const POWERCFG_LID = ['SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION'] as const;
const CANCELLED = /canceled|cancelled|-128/i;

export function defaultExec(file: string, args: readonly string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || messageOf(err)).trim() || messageOf(err)));
      else resolve(stdout);
    });
  });
}

export function createLidController(d: LidDeps): LidController {
  const supported = d.platform === 'darwin' || d.platform === 'win32';
  let streams = 0;
  let lastStreamEndedAt: number | null = null;
  let battery: LidBattery | null = null;
  let armed = false;
  let lidClosed = false;
  let warned = false;
  let chain: Promise<void> = Promise.resolve();
  const subscribers = new Set<(closed: boolean) => void>();

  const current = (): LidStatus => lidStatus({
    enabled: supported && d.getEnabled(), streams, lastStreamEndedAt, now: d.now(), battery,
  });

  const publishLid = (closed: boolean): void => {
    if (closed === lidClosed) return;
    lidClosed = closed;
    for (const cb of subscribers) { try { cb(closed); } catch (e) { d.log(`subscriber failed: ${messageOf(e)}`); } }
  };

  // ---- platform commands ---------------------------------------------------

  const macPmset = (on: boolean) => d.exec('sudo', ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0']);

  const winRestore = async (): Promise<void> => {
    const saved = d.getSavedLidAction();
    if (!saved) return;
    await d.exec('powercfg', ['/setacvalueindex', ...POWERCFG_LID, String(saved.ac)]);
    await d.exec('powercfg', ['/setdcvalueindex', ...POWERCFG_LID, String(saved.dc)]);
    await d.exec('powercfg', ['/setactive', 'SCHEME_CURRENT']);
    d.setSavedLidAction(null);
  };

  const winArm = async (): Promise<void> => {
    // Only save when nothing is saved: after a crash the persisted pair is the
    // user's real setting and the live one is our 0/0.
    if (!d.getSavedLidAction()) {
      const parsed = parsePowercfgLidAction(await d.exec('powercfg', ['/q', ...POWERCFG_LID]));
      if (!parsed) throw new Error('could not read the current lid action from powercfg');
      d.setSavedLidAction(parsed);
    }
    await d.exec('powercfg', ['/setacvalueindex', ...POWERCFG_LID, '0']);
    await d.exec('powercfg', ['/setdcvalueindex', ...POWERCFG_LID, '0']);
    await d.exec('powercfg', ['/setactive', 'SCHEME_CURRENT']);
  };

  const keepAwake = (on: boolean): Promise<void> =>
    d.platform === 'darwin' ? macPmset(on).then(() => undefined) : (on ? winArm() : winRestore());

  const release = async (): Promise<void> => {
    try { await keepAwake(false); } catch (e) { d.log(`release failed: ${messageOf(e)}`); }
    armed = false;
    publishLid(false);
  };

  // ---- macOS sudoers install -----------------------------------------------

  const sudoAllowed = (): Promise<boolean> =>
    d.exec('sudo', ['-n', '-l', PMSET, '-a', 'disablesleep', '1']).then(() => true, () => false);

  const installSudoers = async (): Promise<void> => {
    const rule = sudoersRule(d.user);
    if (!rule) throw new Error(`cannot write a sudoers rule for user "${d.user}"`);
    const dir = mkdtempSync(join(tmpdir(), 'belay-lid-'));
    const file = join(dir, 'belay-lid');
    try {
      writeFileSync(file, rule, { mode: 0o440 });
      chmodSync(file, 0o440);
      // The path rides in argv; AppleScript's `quoted form of` shell-quotes it.
      // The script text itself is a constant.
      //
      // Order matters (TOCTOU): the user-owned temp file is copied to a
      // root-owned staging file FIRST, then validated, then renamed into place
      // — so nothing running as this user can swap the file between the check
      // and the install. The staging name contains a '.', which sudo ignores
      // inside sudoers.d, so it is inert even for the instant it exists.
      const script =
        `do shell script "/usr/bin/install -o root -g wheel -m 0440 " & quoted form of item 1 of argv & " ${SUDOERS_STAGING}` +
        ` && (/usr/sbin/visudo -cf ${SUDOERS_STAGING} && /bin/mv -f ${SUDOERS_STAGING} ${SUDOERS_PATH}` +
        ` || (/bin/rm -f ${SUDOERS_STAGING}; exit 1))"` +
        ' with administrator privileges';
      await d.exec('osascript', ['-e', 'on run argv', '-e', script, '-e', 'end run', file], PROMPT_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const ensureMacPrivilege = async (): Promise<LidReply> => {
    if (await sudoAllowed()) return { ok: true };
    try {
      await installSudoers();
    } catch (e) {
      const why = messageOf(e);
      return {
        ok: false,
        error: CANCELLED.test(why)
          ? 'Admin approval was cancelled, so the switch stays off. Belay needs it once to let the Mac stay awake with the lid closed.'
          : `Could not install the keep-awake permission: ${why}`,
      };
    }
    return (await sudoAllowed())
      ? { ok: true }
      : { ok: false, error: 'The keep-awake permission was installed but sudo still refuses it; see docs/VIRTUAL-DISPLAY.md' };
  };

  // ---- evaluation ------------------------------------------------------------

  const evaluate = (): Promise<void> => {
    chain = chain.then(async () => {
      const status = current();
      const wantArmed = status === 'awake';
      if (wantArmed && !armed) {
        try { await keepAwake(true); armed = true; }
        catch (e) { d.log(`keep-awake failed: ${messageOf(e)}`); }
        if (d.platform === 'win32' && armed) publishLid(true);
      } else if (!wantArmed && armed) {
        await release();
      }
      if (status === 'battery-low' && !warned) { warned = true; d.onWarn(BATTERY_WARNING); }
      if (status !== 'battery-low') warned = false;
    }).catch((e) => d.log(`evaluate failed: ${messageOf(e)}`));
    return chain;
  };

  const pollLid = async (): Promise<void> => {
    if (d.platform !== 'darwin' || !armed) return;
    try {
      const closed = parseClamshell(await d.exec('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4']));
      if (closed !== null) publishLid(closed);
    } catch (e) { d.log(`ioreg failed: ${messageOf(e)}`); }
  };

  return {
    async start() {
      // Crash safety: nothing is armed at start, so normal sleep must be on.
      if (d.platform === 'darwin') {
        try { await macPmset(false); } catch (e) { d.log(`could not restore sleep at start: ${messageOf(e)}`); }
      } else if (d.platform === 'win32') {
        try { await winRestore(); } catch (e) { d.log(`could not restore lid action at start: ${messageOf(e)}`); }
      }
    },
    async stop() {
      await chain.catch(() => {});
      if (armed || d.getSavedLidAction()) await release();
    },
    status: () => ({ supported, enabled: supported && d.getEnabled(), status: current(), lidClosed }),
    async setEnabled(on) {
      if (!supported) return { ok: false, error: `lid-closed mode is not available on ${d.platform}` };
      if (on && d.platform === 'darwin') {
        const granted = await ensureMacPrivilege();
        if (!granted.ok) { d.setEnabled(false); return granted; }
      }
      d.setEnabled(on);
      await evaluate();
      return { ok: true };
    },
    streamStarted() { streams += 1; void evaluate(); },
    streamEnded() {
      streams = Math.max(0, streams - 1);
      if (streams === 0) lastStreamEndedAt = d.now();
      void evaluate();
    },
    subscribe(cb) { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    async tick() {
      // Probes only while the mode could be armed: an idle host runs nothing.
      if (!supported || !d.getEnabled() || current() === 'ready') { if (armed) await evaluate(); return; }
      battery = await d.readBattery().catch(() => null);
      await evaluate();
      await pollLid();
    },
    settle: () => chain,
  };
}

/** Production wiring: real shell, real clock, state.ts for persistence. */
export function lidDepsFor(
  state: Pick<LidDeps, 'getEnabled' | 'setEnabled' | 'getSavedLidAction' | 'setSavedLidAction' | 'onWarn'>,
): LidDeps {
  const platform = process.platform;
  const readBattery = platform === 'darwin'
    ? async () => toLidBattery(await batteryInfo())
    : async () => parseWin32Battery(await defaultExec('powershell', [
      '-NoProfile', '-Command', 'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json',
    ]));
  return {
    platform,
    user: userInfo().username,
    exec: defaultExec,
    now: Date.now,
    readBattery,
    log: (m) => console.warn(`[lid] ${m}`),
    ...state,
  };
}
