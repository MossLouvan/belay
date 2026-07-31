// One measured resource: headline number, meter, history and context line.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Card, Label, Meter, Row, Skeleton, Txt } from '../ui';
import { Sparkline } from './sparkline';
import { average, peak } from './history';
import { severityColor, usageSeverity } from './format';

export interface StatCardProps {
  /** Short resource name, e.g. "CPU". Doubles as the accessible name. */
  title: string;
  /** Percentage 0-100, or null while the first sample is in flight. */
  percent: number | null;
  /** Right-hand supporting line, e.g. "12.4 GB of 32 GB". */
  detail?: string;
  /** Samples for the sparkline, oldest first. */
  history?: readonly number[];
  /**
   * The host answered but cannot measure this resource. Distinct from loading:
   * showing a confident "0%" for a number nobody reported would be a lie.
   */
  unavailable?: boolean;
  testID?: string;
}

/** "avg 23% · peak 91%" over the visible window. */
function WindowSummary({ history }: { history: readonly number[] }) {
  const mean = average(history);
  const high = peak(history);
  if (mean === null || high === null) return null;
  return <Caption>{`avg ${mean}% · peak ${high}%`}</Caption>;
}

export function StatCard({ title, percent, detail, history, unavailable = false, testID }: StatCardProps) {
  const theme = useTheme();
  const loading = percent === null && !unavailable;
  const value = percent ?? 0;
  const tint = unavailable ? theme.colors.borderStrong : severityColor(usageSeverity(value), theme.colors);

  return (
    <Card testID={testID}>
      <Row justify="space-between" align="flex-start">
        <Label>{title}</Label>
        {loading ? (
          <Skeleton width={56} height={20} />
        ) : (
          <Txt
            variant="heading"
            color={unavailable ? theme.colors.textFaint : tint}
            accessibilityLabel={unavailable ? `${title} not reported` : `${title} ${Math.round(value)} percent`}
          >
            {unavailable ? '—' : `${Math.round(value)}%`}
          </Txt>
        )}
      </Row>

      <Meter percent={unavailable ? 0 : value} tint={tint} label={`${title} usage`} />

      {!unavailable && history && history.length > 1 ? (
        <View style={{ marginTop: theme.space.sm }}>
          <Sparkline values={history} tint={tint} accessibilityLabel={`${title} history`} />
        </View>
      ) : null}

      <Row justify="space-between" style={{ marginTop: theme.space.sm }} gap="sm">
        {detail ? (
          <Caption numberOfLines={1} style={{ flex: 1 }}>
            {detail}
          </Caption>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {!unavailable && history ? <WindowSummary history={history} /> : null}
      </Row>
    </Card>
  );
}
