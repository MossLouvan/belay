// Secondary System cards: power, host identity, and the devices paired with it.

import React from 'react';
import { View } from 'react-native';
import { BatteryInfo, SystemStats } from '../api';
import { useTheme } from '../theme';
import { Caption, Card, Column, Label, ListItem, Meter, Row, Txt } from '../ui';
import { batteryHeadline, batterySource, chargeSeverity, fmtAgo, fmtBytes, fmtUptime, osLabel, severityColor } from './format';

/**
 * Power. Only newer hosts report it and only some machines have a battery, so
 * the card is absent — not empty — whenever `battery` is missing or null.
 */
export function BatteryCard({ battery }: { battery: BatteryInfo }) {
  const theme = useTheme();
  const tint = severityColor(chargeSeverity(battery), theme.colors);
  const percent = Math.max(0, Math.min(100, battery.percent));

  return (
    <Card testID="battery-card">
      <Row justify="space-between" align="flex-start">
        <Label>Power</Label>
        <Txt variant="heading" color={tint} accessibilityLabel={`Battery ${Math.round(percent)} percent`}>
          {`${Math.round(percent)}%`}
        </Txt>
      </Row>
      <Meter percent={percent} tint={tint} label="Battery charge" />
      <Row justify="space-between" style={{ marginTop: theme.space.sm }} gap="sm">
        <Caption numberOfLines={1} style={{ flex: 1 }}>
          {batteryHeadline(battery)}
        </Caption>
        <Caption numberOfLines={1}>{batterySource(battery)}</Caption>
      </Row>
    </Card>
  );
}

interface FactProps {
  label: string;
  value: string;
  align?: 'flex-start' | 'flex-end';
}

function Fact({ label, value, align = 'flex-start' }: FactProps) {
  return (
    <Column style={{ flex: 1, alignItems: align }}>
      <Label>{label}</Label>
      <Txt variant="subheading" numberOfLines={2} align={align === 'flex-end' ? 'right' : 'left'}>
        {value}
      </Txt>
    </Column>
  );
}

/** Uptime, operating system and processor. */
export function HostCard({ stats }: { stats: SystemStats | null }) {
  const theme = useTheme();
  return (
    <Card testID="host-card">
      <Row justify="space-between" align="flex-start" gap="md">
        <Fact label="Uptime" value={stats ? fmtUptime(stats.uptimeSec) : '—'} />
        <Fact label="Operating system" value={stats ? osLabel(stats) : '—'} align="flex-end" />
      </Row>
      <View style={{ height: theme.space.sm }} />
      <Caption numberOfLines={2}>
        {stats ? `${stats.cpuModel} · ${stats.cpuCount} cores · ${fmtBytes(stats.memTotal)} installed` : ' '}
      </Caption>
    </Card>
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
export function DevicesCard({ devices, now }: { devices: readonly PairedDevice[]; now: number }) {
  if (devices.length === 0) return null;
  return (
    <Card testID="devices-card">
      <Label>Paired devices</Label>
      {devices.map((device, index) => (
        <ListItem
          key={`${device.name}-${device.createdAt}-${index}`}
          title={device.name}
          subtitle={device.lastSeen > 0 ? `Last seen ${fmtAgo(now - device.lastSeen)}` : 'Never used'}
        />
      ))}
      <Caption>Revoke a device from the Tether window on the computer itself.</Caption>
    </Card>
  );
}
