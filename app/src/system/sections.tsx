// Secondary System sections: power and the host's flat facts — Ledger form
// (docs/DESIGN.md §7.1). The old cards died: the facts are ledger rows now,
// scanning labels down the left edge and machine values down the right.

import React from 'react';
import { LedgerRow } from '../ui';
import type { BatteryInfo, SystemStats } from '../api';
import { StatSection } from './stat-section';
import { batterySource, chargeSeverity, fmtAgo, fmtBytes, fmtUptime, osLabel } from './format';

/**
 * Power. Only newer hosts report it and only some machines have a battery, so
 * the section is absent — not empty — whenever `battery` is missing or null.
 * Charge thresholds are inverted relative to usage, so the severity is passed
 * in rather than derived from the percentage.
 */
export function BatterySection({ battery, bleed = 0 }: { battery: BatteryInfo; bleed?: number }) {
  return (
    <StatSection
      testID="battery-card"
      label="Power"
      percent={Math.max(0, Math.min(100, battery.percent))}
      status={chargeSeverity(battery)}
      detail={`${battery.charging ? 'Charging' : 'On battery'} · ${batterySource(battery)}`}
      bleed={bleed}
    />
  );
}

/**
 * The flat facts: uptime, OS, processor, installed memory. Values render "—"
 * while the first poll is in flight so the ledger's shape never changes.
 */
export function HostLedger({ stats, bleed = 0 }: { stats: SystemStats | null; bleed?: number }) {
  return (
    <>
      <LedgerRow testID="host-card" label="Uptime:" value={stats ? fmtUptime(stats.uptimeSec) : '—'} bleed={bleed} />
      <LedgerRow label="OS:" value={stats ? osLabel(stats) : '—'} bleed={bleed} />
      <LedgerRow label="CPU:" value={stats ? `${stats.cpuModel} · ${stats.cpuCount} cores` : '—'} bleed={bleed} />
      <LedgerRow label="Installed:" value={stats ? fmtBytes(stats.memTotal) : '—'} bleed={bleed} />
    </>
  );
}

/**
 * PairedDevice, parseDevices and the DevicesSection moved out when revoke
 * arrived: the data half lives in devices-model.ts (JSX-free, node-tested)
 * and the section itself in paired-devices.tsx, where the confirmation flow
 * needed room this file's flat exports never had.
 */

/** The "· UPDATED 2S AGO" half of the header status line. */
export function statusLine(stale: boolean, lastOkAt: number | null, now: number): string {
  if (stale) {
    return lastOkAt ? `unreachable · last data ${fmtAgo(now - lastOkAt)}` : 'no response from the computer';
  }
  return lastOkAt ? `live · updated ${fmtAgo(now - lastOkAt)}` : 'connecting…';
}
