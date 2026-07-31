// Live system stats for the Status screen. Mostly Node's os module; disk and
// the friendly OS name / battery come from small platform-aware helpers, so
// this file stays a thin composition layer.

import { cpus, totalmem, freemem, uptime, hostname, platform, release } from 'node:os';

import { createCpuMeter } from './cpu.js';
import { diskInfo } from './disk.js';
import { osName, batteryInfo, BatteryInfo } from './osinfo.js';

// One meter for the process. It samples on its own background cadence (with an
// unref'd timer, so it never holds the process open) and every read returns the
// latest computed figure — so overlapping /system requests all see the same
// sane number instead of racing to consume one delta.
const cpuMeter = createCpuMeter();

export interface Stats {
  readonly hostname: string;
  readonly platform: string;
  readonly release: string;
  /** Friendly OS label, e.g. "macOS 26.3.1" or "Windows 10.0.26100". */
  readonly osName: string;
  readonly osVersion: string;
  readonly cpuCount: number;
  readonly cpuModel: string;
  readonly cpuPercent: number;
  readonly memTotal: number;
  readonly memUsed: number;
  readonly memPercent: number;
  readonly diskTotal: number;
  readonly diskFree: number;
  readonly diskPercent: number;
  /** null on hosts without a battery (or where we cannot read one). */
  readonly battery: BatteryInfo | null;
  readonly uptimeSec: number;
  readonly serverTime: number;
}

export async function getStats(): Promise<Stats> {
  // Independent probes, so run them together rather than in series.
  const [disk, os, battery] = await Promise.all([diskInfo(), osName(), batteryInfo()]);
  const cores = cpus();
  const memTotal = totalmem();
  const memFree = freemem();
  const memUsed = memTotal - memFree;

  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    osName: `${os.name} ${os.version}`,
    osVersion: os.version,
    cpuCount: cores.length,
    cpuModel: cores[0]?.model?.trim() ?? 'unknown',
    cpuPercent: cpuMeter.read(),
    memTotal,
    memUsed,
    memPercent: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0,
    diskTotal: disk?.total ?? 0,
    diskFree: disk?.free ?? 0,
    diskPercent: disk?.percent ?? 0,
    battery,
    uptimeSec: Math.round(uptime()),
    serverTime: Date.now(),
  };
}
