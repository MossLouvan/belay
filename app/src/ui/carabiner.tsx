// The carabiner mark — Belay's brand glyph, drawn once.
//
// The same D-shaped clip hangs off the splash rope, drops in with
// notifications, and anchors the Tailscale setup rope. It used to be drawn
// separately in each of those files, which is exactly how a brand mark
// drifts: three copies, three stroke weights, three slightly different gates.
// One drawing here; every rope clips onto it.
//
// Drawn with positioned Views and border radii, the same technique as every
// other shape in the app (see contours.tsx, activity-chart.tsx) —
// react-native-svg does not render under this Expo release's New
// Architecture, so the glyph that shipped as SVG paths was simply invisible
// on device. Views always paint.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';

export interface CarabinerProps {
  /** Width in points; the clip is drawn about 1.3× taller than wide. */
  readonly size?: number;
  /** Stroke colour. Defaults to the brand accent, `theme.colors.accentGraphic`. */
  readonly color?: string;
  /** Stroke weight. The gate is always drawn a touch heavier so it reads. */
  readonly strokeWidth?: number;
}

/**
 * Simplified D-shaped climbing carabiner: one rounded outline whose left
 * corners bow wider than the right (the spine), plus a short heavier bar
 * across the top where the rope clips in (the gate). Everything is derived
 * from `size`, so it scales cleanly from the 24pt notification clip to the
 * 40pt splash one.
 */
export function Carabiner({ size = 40, color, strokeWidth = 3 }: CarabinerProps) {
  const theme = useTheme();
  const ink = color ?? theme.colors.accentGraphic;
  const width = size;
  const height = size * 1.3;
  const gateWeight = strokeWidth + 1;

  return (
    <View
      style={{ width, height }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {/* Main D-shape body — the spine's corners bow wider on the left. */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderWidth: strokeWidth,
          borderColor: ink,
          borderTopLeftRadius: width * 0.5,
          borderBottomLeftRadius: width * 0.5,
          borderTopRightRadius: width * 0.3,
          borderBottomRightRadius: width * 0.3,
        }}
      />
      {/* Gate — the heavier bar at the top where the rope clips in, tilted a
          touch so it reads as a hinge rather than a thicker outline. */}
      <View
        style={{
          position: 'absolute',
          top: -gateWeight * 0.25,
          left: width * 0.3,
          width: width * 0.32,
          height: gateWeight,
          borderRadius: gateWeight / 2,
          backgroundColor: ink,
          transform: [{ rotate: '-6deg' }],
        }}
      />
    </View>
  );
}
