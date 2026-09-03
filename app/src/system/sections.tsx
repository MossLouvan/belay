// Secondary System pieces: the power stat card, the host-facts card and the
// header status line. Reference form (Next Terminal sweep): stats are bordered
// navy cards; flat facts are hairline-divided rows inside a flush card.

import React from 'react';
import { Card } from '../ui';
import type { BatteryInfo, SystemStats } from '../api';
import { StatCard } from './stat-card';
import { CardRow } from './card-row';
import { PowerGlyph } from './glyphs';
import { batterySource, chargeSeverity, fmtAgo, fmtUptime, osLabel } from './format';

/**
 * Power. Only newer hosts report it and only some machines have a battery, so
 * the card is absent — not empty — whenever `battery` is missing or null.
 * Charge thresholds are inverted relative to usage, so the severity is passed
 * in rather than derived from the percentage.
 */
export function BatteryCard({ battery, style }: { battery: BatteryInfo; style?: React.ComponentProps<typeof StatCard>['style'] }) {
  return (
    <StatCard
      testID="battery-card"
      label="Power"
      percent={Math.max(0, Math.min(100, battery.percent))}
      status={chargeSeverity(battery)}
      detail={battery.charging ? `Charging · ${batterySource(battery)}` : 'On battery'}
      glyph={<PowerGlyph />}
      style={style}
    />
  );
}

/**
 * The flat facts as a flush card of divided rows. Values render "—" while the
 * first poll is in flight so the card's shape never changes. The CPU model and
 * installed memory live in the CPU/Memory stat cards' detail lines — repeating
 * them here would be a second voice for the same fact.
 */
export function HostCard({ stats }: { stats: SystemStats | null }) {
  return (
    <Card testID="host-card" flush title="Host">
      <CardRow label="Uptime" value={stats ? fmtUptime(stats.uptimeSec) : '—'} />
      <CardRow label="OS" value={stats ? osLabel(stats) : '—'} />
      <CardRow label="Processor" value={stats ? stats.cpuModel : '—'} divider={false} />
    </Card>
  );
}

/** The "· UPDATED 2S AGO" half of the header status line. */
export function statusLine(stale: boolean, lastOkAt: number | null, now: number): string {
  if (stale) {
    return lastOkAt ? `unreachable · last data ${fmtAgo(now - lastOkAt)}` : 'no response from the computer';
  }
  return lastOkAt ? `live · updated ${fmtAgo(now - lastOkAt)}` : 'connecting…';
}
