// Live system stats for the Status screen. Pure Node os module plus one cheap
// wmic/powershell call for disk, so there is nothing extra to install.

import { cpus, totalmem, freemem, uptime, hostname, platform, release } from 'node:os';
import { exec } from 'node:child_process';

let lastCpu = sampleCpu();

function sampleCpu(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

// CPU load is the change in busy time between two samples, so it needs a
// previous reading — the first call reflects the interval since startup.
function cpuPercent(): number {
  const now = sampleCpu();
  const idleDiff = now.idle - lastCpu.idle;
  const totalDiff = now.total - lastCpu.total;
  lastCpu = now;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

function diskInfo(): Promise<{ total: number; free: number } | null> {
  return new Promise((resolve) => {
    // Query the system drive's free/size via PowerShell's CIM. Wrapped so any
    // failure just yields null rather than breaking the stats payload.
    const cmd =
      'powershell -NoProfile -Command "$d=Get-PSDrive -Name ($env:SystemDrive.TrimEnd(\':\')); ' +
      'Write-Output ($d.Used + $d.Free); Write-Output $d.Free"';
    exec(cmd, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const lines = stdout.trim().split(/\r?\n/).map((n) => Number(n.trim()));
      if (lines.length < 2 || !isFinite(lines[0]) || !isFinite(lines[1])) { resolve(null); return; }
      resolve({ total: lines[0], free: lines[1] });
    });
  });
}

export async function getStats() {
  const disk = await diskInfo();
  const total = totalmem();
  const free = freemem();
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model?.trim() ?? 'unknown',
    cpuPercent: cpuPercent(),
    memTotal: total,
    memUsed: total - free,
    memPercent: Math.round(((total - free) / total) * 100),
    diskTotal: disk?.total ?? 0,
    diskFree: disk?.free ?? 0,
    diskPercent: disk ? Math.round(((disk.total - disk.free) / disk.total) * 100) : 0,
    uptimeSec: Math.round(uptime()),
    serverTime: Date.now(),
  };
}
