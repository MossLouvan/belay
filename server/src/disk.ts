// Disk usage for the Status screen.
//
// There is no cross-platform Node API that reports the numbers a user
// recognises, so each platform gets its own cheap shell-out:
//   win32  - PowerShell's Get-PSDrive on the system drive (unchanged behaviour)
//   darwin - `df -kP` on the data volume, which is what Finder reports
//   other  - `df -kP /`
//
// Every failure path resolves to null rather than throwing, so a disk problem
// degrades the Status screen instead of breaking the whole stats payload. The
// reason is logged once per distinct message so a polled endpoint cannot spam
// the console.

import { exec, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface DiskInfo {
  readonly total: number;
  readonly free: number;
  readonly percent: number;
}

const DISK_TIMEOUT_MS = 4000;
const KIB = 1024;

// On Apple silicon / APFS, `/` is a read-only sealed system snapshot: its
// "used" figure is a few GB and says nothing about the user's storage. The
// writable data volume is the one Finder and System Settings report on.
const DARWIN_DATA_VOLUME = '/System/Volumes/Data';
const ROOT_VOLUME = '/';

// Kept verbatim (including the surrounding `exec` invocation below) so the
// Windows behaviour is byte-for-byte what it was before macOS support landed.
const POWERSHELL_DISK_COMMAND =
  'powershell -NoProfile -Command "$d=Get-PSDrive -Name ($env:SystemDrive.TrimEnd(\':\')); ' +
  'Write-Output ($d.Used + $d.Free); Write-Output $d.Free"';

function createOnceLogger(): (message: string) => void {
  const seen = new Set<string>();
  return (message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    console.warn(`[disk] ${message}`);
  };
}

const logOnce = createOnceLogger();

/** Percentage of capacity in use, clamped and rounded. */
function usedPercent(total: number, free: number): number {
  if (!(total > 0)) return 0;
  const ratio = (total - free) / total;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Parse POSIX `df -kP` output into byte counts.
 *
 * Filesystem names and mount points can contain spaces, so rather than
 * splitting on whitespace by column index this matches the block of four
 * numeric fields (1024-blocks, used, available, capacity%) that `-P` guarantees
 * appear on a single line in that order. Returns null on anything unexpected.
 */
export function parseDf(stdout: string): DiskInfo | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines.slice(1)) {
    const match = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(line);
    if (!match) continue;
    const blocks = Number(match[1]);
    const used = Number(match[2]);
    const available = Number(match[3]);
    const capacity = Number(match[4]);
    if (!Number.isFinite(blocks) || !Number.isFinite(used) || !Number.isFinite(available)) continue;
    if (blocks <= 0) continue;
    const total = blocks * KIB;
    const free = available * KIB;
    // df's own capacity column is used/(used+available), which on APFS differs
    // from (total-free)/total because of snapshots and purgeable space. Prefer
    // the number the OS itself reports; fall back to computing it.
    const percent = Number.isFinite(capacity) && capacity >= 0 && capacity <= 100
      ? Math.round(capacity)
      : usedPercent(total, free);
    return { total, free, percent };
  }
  return null;
}

/**
 * Parse the two-line PowerShell output (total bytes, then free bytes).
 * Kept separate from the Windows call site so it is testable on any platform.
 */
export function parsePowerShellDisk(stdout: string): DiskInfo | null {
  const numbers = stdout.trim().split(/\r?\n/).map((n) => Number(n.trim()));
  if (numbers.length < 2) return null;
  const [total, free] = numbers;
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
  return { total, free, percent: usedPercent(total, free) };
}

function runFile(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: DISK_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        logOnce(`${file} failed: ${err.message}`);
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

function runShell(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(command, { timeout: DISK_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        logOnce(`disk query failed: ${err.message}`);
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

/** The mount point whose usage is worth showing to the user. */
export function diskTarget(platform: string = process.platform): string {
  if (platform === 'darwin' && existsSync(DARWIN_DATA_VOLUME)) return DARWIN_DATA_VOLUME;
  return ROOT_VOLUME;
}

export async function diskInfo(): Promise<DiskInfo | null> {
  if (process.platform === 'win32') {
    const stdout = await runShell(POWERSHELL_DISK_COMMAND);
    if (stdout === null) return null;
    const parsed = parsePowerShellDisk(stdout);
    if (!parsed) logOnce('could not parse PowerShell disk output');
    return parsed;
  }

  const stdout = await runFile('df', ['-kP', diskTarget()]);
  if (stdout === null) return null;
  const parsed = parseDf(stdout);
  if (!parsed) logOnce('could not parse df output');
  return parsed;
}
