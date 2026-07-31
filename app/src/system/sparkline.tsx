// Bar sparkline drawn from plain Views.
//
// No SVG or charting dependency: the shape is a fixed number of thin columns,
// which react-native-web and iOS both render cheaply, and it stays crisp at any
// width without a layout measurement pass.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { HISTORY_CAPACITY } from './history';

export interface SparklineProps {
  /** Percentages, oldest first. Shorter arrays are right-aligned. */
  values: readonly number[];
  tint: string;
  height?: number;
  capacity?: number;
  /** Read out instead of the bars, which carry no meaning to a screen reader. */
  accessibilityLabel?: string;
}

const MIN_BAR_HEIGHT = 2;

export function Sparkline({
  values,
  tint,
  height = 40,
  capacity = HISTORY_CAPACITY,
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
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 1.5,
        backgroundColor: theme.colors.surfaceAlt,
        borderRadius: theme.radius.sm,
        paddingHorizontal: 4,
        paddingVertical: 3,
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: padding }, (_, i) => (
        <View key={`pad-${i}`} style={{ flex: 1 }} />
      ))}
      {window.map((value, i) => (
        <View
          key={`bar-${start + i}`}
          style={{
            flex: 1,
            minHeight: MIN_BAR_HEIGHT,
            height: `${Math.max(MIN_BAR_HEIGHT, value)}%`,
            backgroundColor: tint,
            borderRadius: 1.5,
            // The most recent sample reads at full strength; older ones recede.
            opacity: i === window.length - 1 ? 1 : 0.55,
          }}
        />
      ))}
    </View>
  );
}
