// The reference's "Activity Statistics" panel, drawn from plain Views — no SVG
// or charting dependency (react-native-svg isn't a dep). A filled area chart:
// each history sample is a thin column filled from the baseline in a
// translucent accent, capped by a 2pt bright line at its top so the silhouette
// reads as an area-under-a-line, the way the Next Terminal dashboard's chart
// does. Faint gridlines and a compact legend complete the panel.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Micro } from '../ui';

export interface ActivityChartProps {
  /** Percentages 0..100, oldest first. Right-aligned if shorter than capacity. */
  values: readonly number[];
  /** Legend label, e.g. "CPU". */
  label: string;
  /** Current value for the legend readout. */
  current?: number;
  height?: number;
  capacity?: number;
  accessibilityLabel?: string;
}

const DEFAULT_HEIGHT = 128;
const DEFAULT_CAPACITY = 48;
const CAP_HEIGHT = 2; // the bright "line" on top of each column
const GRIDLINES = [0.25, 0.5, 0.75];

export function ActivityChart({
  values,
  label,
  current,
  height = DEFAULT_HEIGHT,
  capacity = DEFAULT_CAPACITY,
  accessibilityLabel,
}: ActivityChartProps) {
  const theme = useTheme();
  const start = Math.max(0, values.length - capacity);
  const window = values.slice(start);
  const pad = capacity - window.length;
  const accent = theme.colors.accentGraphic;
  const latest = current ?? (window.length ? window[window.length - 1] : 0);

  return (
    <View accessibilityRole="image" accessibilityLabel={accessibilityLabel ?? `${label} history`}>
      {/* Plot area */}
      <View style={{ height, position: 'relative', overflow: 'hidden' }}>
        {/* Faint horizontal gridlines — decorative, hidden from a11y. */}
        {GRIDLINES.map((g) => (
          <View
            key={`grid-${g}`}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ pointerEvents: 'none',
              position: 'absolute',
              left: 0,
              right: 0,
              top: height * g,
              height: theme.layout.hairline,
              backgroundColor: theme.colors.border,
            }}
          />
        ))}
        {/* Columns */}
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}>
          {Array.from({ length: pad }, (_, i) => <View key={`pad-${i}`} style={{ flex: 1 }} />)}
          {window.map((v, i) => {
            const clamped = Math.max(0, Math.min(100, v));
            return (
              <View key={`col-${start + i}`} style={{ flex: 1, height: `${Math.max(1, clamped)}%`, justifyContent: 'flex-start' }}>
                {/* the bright line cap */}
                <View style={{ height: CAP_HEIGHT, backgroundColor: accent }} />
                {/* the translucent area fill below it */}
                <View style={{ flex: 1, backgroundColor: accent, opacity: 0.16 }} />
              </View>
            );
          })}
        </View>
      </View>
      {/* Legend */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, marginTop: theme.space.sm }}>
        <View style={{ width: 10, height: 3, borderRadius: 1.5, backgroundColor: accent }} />
        <Micro tone="dim">{label}</Micro>
        <Micro tone="faint">{`${Math.round(latest)}%`}</Micro>
      </View>
    </View>
  );
}
