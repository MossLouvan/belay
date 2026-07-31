// Human-readable OS identity and (on laptops) battery state.
//
// `os.release()` returns a kernel version — "25.3.0" on macOS 26.3, which means
// nothing to a user. This module turns that into "macOS 26.3.1" where the
// platform can tell us cheaply, and falls back to the raw values otherwise.
//
// Battery is macOS-only for now (`pmset`). Everywhere else it is null, which
// the client should read as "this host has no battery worth showing".

import { execFile } from 'node:child_process';
import { platform, release } from 'node:os';

const PROBE_TIMEOUT_MS = 3000;
const BATTERY_TTL_MS = 5000;

export interface OsName {
  readonly name: string;
  readonly version: string;
}

export interface BatteryInfo {
  readonly percent: number;
  readonly charging: boolean;
  readonly source: string;
}

function createOnceLogger(): (message: string) => void {
  const seen = new Set<string>();
  return (message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    console.warn(`[osinfo] ${message}`);
  };
}

const logOnce = createOnceLogger();

function runFile(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        logOnce(`${file} failed: ${err.message}`);
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Parse `sw_vers` key/value output. Returns null if the expected keys absent. */
export function parseSwVers(stdout: string): OsName | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const name = fields.get('ProductName');
  const version = fields.get('ProductVersion');
  if (!name || !version) return null;
  return { name, version };
}

/**
 * Parse `pmset -g batt`. Example:
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=123)\t78%; discharging; 6:55 remaining present: true
 */
export function parsePmsetBattery(stdout: string): BatteryInfo | null {
  const percentMatch = /(\d{1,3})%/.exec(stdout);
  if (!percentMatch) return null;
  const percent = Math.max(0, Math.min(100, Number(percentMatch[1])));
  if (!Number.isFinite(percent)) return null;
  const sourceMatch = /Now drawing from '([^']+)'/.exec(stdout);
  const source = sourceMatch ? sourceMatch[1] : 'unknown';
  // "charging" also covers "finishing charge"; "charged" on AC is not charging.
  const charging = /;\s*(charging|finishing charge)/i.test(stdout);
  return { percent, charging, source };
}

// The OS name cannot change while the process runs, so resolve it at most once.
let osNamePromise: Promise<OsName> | null = null;

function fallbackOsName(): OsName {
  const p = platform();
  if (p === 'win32') return { name: 'Windows', version: release() };
  if (p === 'darwin') return { name: 'macOS', version: release() };
  return { name: p, version: release() };
}

export function osName(): Promise<OsName> {
  if (osNamePromise) return osNamePromise;
  osNamePromise = (async () => {
    if (platform() !== 'darwin') return fallbackOsName();
    const stdout = await runFile('sw_vers', []);
    if (stdout === null) return fallbackOsName();
    return parseSwVers(stdout) ?? fallbackOsName();
  })();
  return osNamePromise;
}

// Battery changes slowly; the Status screen polls once a second, so cache it
// briefly rather than spawning `pmset` on every request.
function createBatteryReader(): () => Promise<BatteryInfo | null> {
  let cachedAt = 0;
  let cached: BatteryInfo | null = null;
  let inFlight: Promise<BatteryInfo | null> | null = null;

  return async () => {
    if (platform() !== 'darwin') return null;
    if (Date.now() - cachedAt < BATTERY_TTL_MS) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const stdout = await runFile('pmset', ['-g', 'batt']);
      const parsed = stdout === null ? null : parsePmsetBattery(stdout);
      cached = parsed;
      cachedAt = Date.now();
      inFlight = null;
      return parsed;
    })();
    return inFlight;
  };
}

export const batteryInfo = createBatteryReader();
