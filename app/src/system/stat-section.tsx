// One measured resource as a Ledger meter section: label + big tabular
// numeral, the 2pt track, an inline sparkline, and a micro detail line
// (docs/DESIGN.md §7). Replaces the old StatCard — no fill, no border, no
// radius; the status colour lives in the numeral and track fill only.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { MeterSection, Micro, Row, Rule, Skeleton, Txt } from '../ui';
import { Sparkline } from './sparkline';
import { average, peak } from './history';
import { usageSeverity } from './format';

export interface StatSectionProps {
  /** Short resource name, e.g. "CPU". Doubles as the accessible name. */
  label: string;
  /** Percentage 0-100, or null while the first sample is in flight. */
  percent: number | null;
  /** Left half of the micro detail line, e.g. "APPLE M3 · 8 CORES". */
  detail?: string;
  /** Samples for the sparkline, oldest first. */
  history?: readonly number[];
  /**
   * The host answered but cannot measure this resource. Distinct from loading:
   * showing a confident "0%" for a number nobody reported would be a lie.
   */
  unavailable?: boolean;
  /** Overrides the usage thresholds, e.g. for battery charge. */
  status?: 'good' | 'warn' | 'bad';
  /** How far the closing hairline bleeds past the page padding. */
  bleed?: number;
  testID?: string;
}

/** "AVG 23 · PEAK 91" over the visible window, right-aligned on the detail line. */
const windowSummary = (history: readonly number[] | undefined): string | null => {
  if (!history) return null;
  const mean = average(history);
  const high = peak(history);
  return mean === null || high === null ? null : `avg ${mean} · peak ${high}`;
};

export function StatSection({
  label,
  percent,
  detail,
  history,
  unavailable = false,
  status,
  bleed = 0,
  testID,
}: StatSectionProps) {
  const theme = useTheme();
  const loading = percent === null && !unavailable;
  const value = percent ?? 0;
  const summary = unavailable ? null : windowSummary(history);

  // The detail line and closing rule are shared by every state; the numeral
  // row above them is the only part that changes, so the layout never reflows
  // when data lands or a resource turns out to be unmeasurable.
  const detailRow =
    detail || summary ? (
      <Row justify="space-between" gap="sm">
        {detail ? (
          <Micro numberOfLines={1} style={{ flexShrink: 1 }}>
            {detail}
          </Micro>
        ) : (
          <View />
        )}
        {summary ? <Micro>{summary}</Micro> : null}
      </Row>
    ) : null;

  if (loading || unavailable) {
    return (
      <View testID={testID} style={{ gap: theme.space.xs }}>
        <Row justify="space-between" align="flex-end" gap="sm">
          <Txt variant="label" tone="dim">
            {label}
          </Txt>
          {loading ? (
            <Skeleton width={72} height={34} />
          ) : (
            <Txt
              variant="numeral"
              tone="faint"
              accessibilityLabel={`${label} not reported`}
            >
              —
            </Txt>
          )}
        </Row>
        <View style={{ height: theme.layout.ruleEmphasis, backgroundColor: theme.colors.surfaceAlt }} />
        {detailRow}
        <Rule bleed={bleed} style={{ marginTop: theme.space.xxs }} />
      </View>
    );
  }

  const level = status ?? usageSeverity(value);
  return (
    <View testID={testID} style={{ gap: theme.space.xs }}>
      <MeterSection
        label={label}
        value={`${Math.round(value)}%`}
        percent={value}
        status={level}
        spark={
          history && history.length > 1 ? (
            <Sparkline values={history} tint={theme.colors[level]} accessibilityLabel={`${label} history`} />
          ) : undefined
        }
        rule={false}
      />
      {detailRow}
      <Rule bleed={bleed} style={{ marginTop: theme.space.xxs }} />
    </View>
  );
}
