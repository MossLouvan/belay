// Used memory for the Status screen.
//
// Node's `freemem()` is honest everywhere except macOS, where it counts only
// truly free pages: file cache, inactive and purgeable pages all read as
// "used", so an idle Mac shows ~95% (#67). Activity Monitor's figure is
// active + wired + compressed, which `vm_stat` reports; that is what darwin
// gets here. Every other platform keeps `totalmem() - freemem()`, and so does
// darwin whenever vm_stat is missing or unparsable.

import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

const VM_STAT_TIMEOUT_MS = 2000;
/** vm_stat is a process spawn; polled every second by several phones, once per second is plenty. */
const CACHE_MS = 1000;

const USED_PAGE_LINES: readonly RegExp[] = [
  /^Pages active:\s+(\d+)/m,
  /^Pages wired down:\s+(\d+)/m,
  /^Pages occupied by compressor:\s+(\d+)/m,
];

/** Bytes in use per `vm_stat` (active + wired + compressor pages), or null if the output is not vm_stat's. */
export function parseVmStat(stdout: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
  if (!(pageSize > 0)) return null;
  let pages = 0;
  for (const pattern of USED_PAGE_LINES) {
    const match = pattern.exec(stdout);
    if (!match) return null;
    pages += Number(match[1]);
  }
  return pages * pageSize;
}

function runVmStat(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('vm_stat', [], { timeout: VM_STAT_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : parseVmStat(stdout));
    });
  });
}

let cached: { at: number; used: number } | null = null;

/** Bytes of memory in use, read the way the host OS itself reports it. */
export async function memUsed(): Promise<number> {
  const fallback = totalmem() - freemem();
  if (process.platform !== 'darwin') return fallback;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.used;
  const used = await runVmStat();
  if (used === null) return fallback;
  cached = { at: now, used };
  return used;
}
