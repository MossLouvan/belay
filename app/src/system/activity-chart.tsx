// The reference's "Activity Statistics" panel, drawn from plain Views — no SVG
// or charting dependency (react-native-svg isn't a dep). A filled area chart:
// each history sample is a thin column filled from the baseline in a
// translucent accent, capped by a 2pt bright line at its top so the silhouette
// reads as an area-under-a-line, the way the Next Terminal dashboard's chart
// does. Faint gridlines and a compact legend complete the panel.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Micro, Txt } from '../ui';
import { chartHasShape } from './chart-shape';

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
/** The legend's colour swatch — glyph geometry, not spacing. */
const LEGEND_W = 10;
const LEGEND_H = 3;

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
  const plottable = chartHasShape(values);

  // One or two samples against a 48-slot window and three gridlines is not a
  // chart with barely any data in it — it is 46 empty slots, a ruled grid and
  // a sliver at the right edge, which reads as a chart that failed to load.
  // Say what is actually happening instead, in the same box, so the panel does
  // not jump when the shape arrives.
  if (!plottable) {
    return (
      <View accessibilityRole="text" accessibilityLabel={`${label} history: still measuring`}>
        <View style={{ height, alignItems: 'center', justifyContent: 'center', gap: theme.space.xxs }}>
          <Txt variant="body" tone="dim">Measuring…</Txt>
          <Micro tone="faint">The graph fills in as samples arrive.</Micro>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, marginTop: theme.space.sm }}>
          <View style={{ width: LEGEND_W, height: LEGEND_H, borderRadius: LEGEND_H / 2, backgroundColor: accent }} />
          <Micro tone="dim">{label}</Micro>
          <Micro tone="faint">{`${Math.round(latest)}%`}</Micro>
        </View>
      </View>
    );
  }

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
        <View style={{ width: LEGEND_W, height: LEGEND_H, borderRadius: LEGEND_H / 2, backgroundColor: accent }} />
        <Micro tone="dim">{label}</Micro>
        <Micro tone="faint">{`${Math.round(latest)}%`}</Micro>
      </View>
    </View>
  );
}
