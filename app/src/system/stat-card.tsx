// One measured resource as a reference-style stat card: small uppercase label
// with a quiet trailing glyph, a big tabular numeral, an inline sparkline, a
// thin blue gauge on a recessed track, and a one-line micro detail.
//
// Colour discipline (sweep rules): the gauge fill is always `accentGraphic`
// blue; semantic amber/red appears only as a small dot beside the numeral and
// a tint on the numeral itself — never as a big fill.

import React from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { Card, Dot, Micro, Row, Skeleton, Txt } from '../ui';
import { Sparkline } from './sparkline';
import { usageSeverity } from './format';

export interface StatCardProps {
  /** Short resource name, e.g. "CPU". Doubles as the accessible name. */
  label: string;
  /** Percentage 0-100, or null while the first sample is in flight. */
  percent: number | null;
  /** The micro detail line, e.g. "APPLE M3 · 8 CORES". */
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
  /** Quiet trailing icon in the card's top-right corner. */
  glyph?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Bars shown inline beside the numeral — sized for a half-width card. */
const SPARK_CAPACITY = 20;
const SPARK_HEIGHT = 26;
/** Gauge thickness — thin, per the reference. */
const TRACK_HEIGHT = 3;

export function StatCard({
  label,
  percent,
  detail,
  history,
  unavailable = false,
  status,
  glyph,
  style,
  testID,
}: StatCardProps) {
  const theme = useTheme();
  const loading = percent === null && !unavailable;
  const value = Math.max(0, Math.min(100, percent ?? 0));
  const level = status ?? usageSeverity(value);
  const alert = !loading && !unavailable && level !== 'good';

  // Shared frame: header, numeral row, gauge, detail. Only the numeral row's
  // contents change between states, so the grid never reflows as data lands.
  const gauge = (
    <View
      style={{
        height: TRACK_HEIGHT,
        borderRadius: TRACK_HEIGHT / 2,
        backgroundColor: theme.colors.surfaceAlt,
        overflow: 'hidden',
      }}
    >
      {!loading && !unavailable ? (
        <View
          style={{
            width: `${value}%`,
            height: '100%',
            borderRadius: TRACK_HEIGHT / 2,
            backgroundColor: theme.colors.accentGraphic,
          }}
        />
      ) : null}
    </View>
  );

  const numeral = loading ? (
    <Skeleton width={72} height={34} />
  ) : unavailable ? (
    <Txt variant="numeral" tone="faint" accessibilityLabel={`${label} not reported`}>
      —
    </Txt>
  ) : (
    <Row gap="xs" align="center">
      {alert ? <Dot status={level} size={7} /> : null}
      <Txt
        variant="numeral"
        color={alert ? theme.colors[level] : theme.colors.text}
        accessibilityLabel={`${label} ${Math.round(value)} percent`}
      >
        {`${Math.round(value)}%`}
      </Txt>
    </Row>
  );

  return (
    <Card testID={testID} title={label} trailing={glyph} style={style}>
      <View style={{ gap: theme.space.xs }}>
        <Row justify="space-between" align="flex-end" gap="sm">
          {numeral}
          {!loading && !unavailable && history && history.length > 1 ? (
            <View accessibilityElementsHidden style={{ flexShrink: 1, overflow: 'hidden' }}>
              <Sparkline
                values={history}
                tint={theme.colors.accentGraphic}
                height={SPARK_HEIGHT}
                capacity={SPARK_CAPACITY}
                accessibilityLabel={`${label} history`}
              />
            </View>
          ) : null}
        </Row>
        {gauge}
        {detail ? <Micro numberOfLines={1}>{detail}</Micro> : null}
      </View>
    </Card>
  );
}
