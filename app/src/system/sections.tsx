// Secondary System sections: power, the host's flat facts, and the devices
// paired with it — Ledger form (docs/DESIGN.md §7.1). The old cards died: the
// facts are ledger rows now, scanning labels down the left edge and machine
// values down the right.

import React from 'react';
import { useTheme } from '../theme';
import { Caption, LedgerRow, Section } from '../ui';
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

export interface PairedDevice {
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Narrows the untyped `/devices` payload. The host truncates tokens before it
 * sends them and we drop the field entirely — a device token, even partial, has
 * no business being rendered.
 */
export function parseDevices(payload: unknown): readonly PairedDevice[] {
  if (!isRecord(payload) || !Array.isArray(payload.devices)) return [];
  return payload.devices.flatMap((entry: unknown): PairedDevice[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return [];
    return [{ name: entry.name, createdAt: numberOr(entry.createdAt, 0), lastSeen: numberOr(entry.lastSeen, 0) }];
  });
}

/** Devices this host has paired. Read-only: revoking happens on the computer. */
export function DevicesSection({ devices, now, bleed = 0 }: { devices: readonly PairedDevice[]; now: number; bleed?: number }) {
  const theme = useTheme();
  if (devices.length === 0) return null;
  return (
    <Section testID="devices-card" label="Paired devices" bleed={bleed}>
      {devices.map((device, index) => (
        <LedgerRow
          key={`${device.name}-${device.createdAt}-${index}`}
          label={device.name}
          value={device.lastSeen > 0 ? `seen ${fmtAgo(now - device.lastSeen)}` : 'never used'}
          valueTone="dim"
          // The section draws the closing hairline; a rule under the last row
          // would double it within 8pt (docs/DESIGN.md §6).
          rule={index < devices.length - 1}
          bleed={bleed}
        />
      ))}
      <Caption style={{ marginTop: theme.space.xs }}>
        Revoke a device from the Tether window on the computer itself.
      </Caption>
    </Section>
  );
}

/** The "· UPDATED 2S AGO" half of the header status line. */
export function statusLine(stale: boolean, lastOkAt: number | null, now: number): string {
  if (stale) {
    return lastOkAt ? `unreachable · last data ${fmtAgo(now - lastOkAt)}` : 'no response from the computer';
  }
  return lastOkAt ? `live · updated ${fmtAgo(now - lastOkAt)}` : 'connecting…';
}
