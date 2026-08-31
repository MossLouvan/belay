// Bar sparkline drawn from plain Views.
//
// No SVG or charting dependency: the shape is a fixed number of thin columns,
// which react-native-web and iOS both render cheaply, and it stays crisp
// without a layout measurement pass. Ledger form (docs/DESIGN.md §7): a bare
// 32pt strip with no box around it — bars in `textFaint`, only the newest
// sample carrying the status colour, so the meter's one colour stays the
// numeral and the track fill plus this single live mark.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';

export interface SparklineProps {
  /** Percentages, oldest first. Shorter arrays are right-aligned. */
  values: readonly number[];
  /** Status colour for the newest sample only. */
  tint: string;
  height?: number;
  /** Samples shown; also fixes the strip's width so layouts never shift. */
  capacity?: number;
  /** Read out instead of the bars, which carry no meaning to a screen reader. */
  accessibilityLabel?: string;
}

const MIN_BAR_HEIGHT = 2;
const BAR_WIDTH = 2;
const BAR_GAP = 1;
/** Inline beside a numeral, so shorter and narrower than the old card chart. */
const DEFAULT_HEIGHT = 32;
const DEFAULT_CAPACITY = 32;

export function Sparkline({
  values,
  tint,
  height = DEFAULT_HEIGHT,
  capacity = DEFAULT_CAPACITY,
  accessibilityLabel,
}: SparklineProps) {
  const theme = useTheme();
  const start = Math.max(0, values.length - capacity);
  const window = values.slice(start);
  const padding = capacity - window.length;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{
        height,
        width: capacity * (BAR_WIDTH + BAR_GAP) - BAR_GAP,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: BAR_GAP,
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: padding }, (_, i) => (
        <View key={`pad-${i}`} style={{ width: BAR_WIDTH }} />
      ))}
      {window.map((value, i) => (
        <View
          key={`bar-${start + i}`}
          style={{
            width: BAR_WIDTH,
            minHeight: MIN_BAR_HEIGHT,
            height: `${Math.max(MIN_BAR_HEIGHT, value)}%`,
            backgroundColor: i === window.length - 1 ? tint : theme.colors.textFaint,
            opacity: i === window.length - 1 ? 1 : 0.55,
          }}
        />
      ))}
    </View>
  );
}
