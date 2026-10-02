// Lid-closed mode: the pure half. Arm/release policy plus the parsers for the
// shell probes (ioreg clamshell, powercfg LIDACTION, Win32_Battery). No I/O —
// lid-host.ts is the thin shell that runs commands and feeds this.

import type { BatteryInfo } from './osinfo.js';

/** Keep-awake survives this long after the last stream ends, so a phone that
 *  drops and reconnects with the lid shut still finds the host awake. */
export const LID_GRACE_MS = 30 * 60 * 1000;
/** On battery power, release at this level and warn the phone. */
export const BATTERY_CUTOFF_PERCENT = 20;
export const BATTERY_WARNING =
  `Battery at ${BATTERY_CUTOFF_PERCENT}% — your computer will sleep soon; plug it in`;

export type LidStatus = 'off' | 'ready' | 'awake' | 'battery-low';

export interface LidBattery {
  readonly percent: number;
  readonly onBattery: boolean;
}

export interface LidInput {
  readonly enabled: boolean;
  readonly streams: number;
  readonly lastStreamEndedAt: number | null;
  readonly now: number;
  readonly battery: LidBattery | null;
}

/** The one decision: armed (`awake`) means keep-awake must be on right now. */
export function lidStatus(i: LidInput): LidStatus {
  if (!i.enabled) return 'off';
  const inGrace = i.lastStreamEndedAt !== null && i.now - i.lastStreamEndedAt < LID_GRACE_MS;
  if (i.streams <= 0 && !inGrace) return 'ready';
  if (i.battery && i.battery.onBattery && i.battery.percent <= BATTERY_CUTOFF_PERCENT) return 'battery-low';
  return 'awake';
}

/** `ioreg -r -k AppleClamshellState -d 4` → true when the lid is shut. */
export function parseClamshell(stdout: string): boolean | null {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(stdout);
  return m ? m[1] === 'Yes' : null;
}

export function toLidBattery(b: BatteryInfo | null): LidBattery | null {
  return b ? { percent: b.percent, onBattery: b.source === 'Battery Power' } : null;
}

/** `powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION` → the two current indexes. */
export function parsePowercfgLidAction(stdout: string): { ac: number; dc: number } | null {
  const ac = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(stdout);
  const dc = /Current DC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(stdout);
  if (!ac || !dc) return null;
  return { ac: parseInt(ac[1], 16), dc: parseInt(dc[1], 16) };
}

/** `Get-CimInstance Win32_Battery | ConvertTo-Json` → first battery. BatteryStatus 1 = discharging. */
export function parseWin32Battery(stdout: string): LidBattery | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof first !== 'object' || first === null) return null;
  const r = first as Record<string, unknown>;
  if (typeof r.EstimatedChargeRemaining !== 'number' || !Number.isFinite(r.EstimatedChargeRemaining)) return null;
  return {
    percent: Math.max(0, Math.min(100, r.EstimatedChargeRemaining)),
    onBattery: r.BatteryStatus === 1,
  };
}

export const PMSET = '/usr/bin/pmset';
export const SUDOERS_PATH = '/etc/sudoers.d/belay-lid';

// POSIX portable username: anything else could smuggle sudoers syntax.
const SAFE_USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;

/** The sudoers rule: exactly the two pmset invocations, nothing else. */
export function sudoersRule(user: string): string | null {
  if (!SAFE_USER.test(user) || user.toUpperCase() === 'ALL') return null;
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1\n`;
}
