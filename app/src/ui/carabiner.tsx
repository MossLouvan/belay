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
 * The D-shaped clip: an offset body with a heavier spine, the gate bar the
 * rope clips over, and the screw-gate lock.
 *
 * Drawn flat, in `ink` alone. It used to carry a drop shadow and four white
 * specular "catch-lights" at fixed alphas — which made the mark read as
 * polished metal on the dark Fieldwork page and as a smear of invisible
 * white-on-white on Current. The Ledger system is flat (`theme.elevation` is
 * pinned to zero shadows), so those layers are gone: the same drawing now
 * reads correctly on both grounds, in whatever colour it is handed.
 */
export function Carabiner({ size = 40, color, strokeWidth = 3 }: CarabinerProps) {
  const theme = useTheme();
  const ink = color ?? theme.colors.accentGraphic;
  const width = size;
  const height = size * 1.3;
  const gateWeight = strokeWidth + 1.5;
  const spineWeight = strokeWidth + 1; // Thicker spine for mass

  return (
    <View
      style={{ width, height }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {/* Spine (left side) — thicker stroke for mass */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: width * 0.52,
          height: height,
          borderLeftWidth: spineWeight,
          borderTopWidth: strokeWidth,
          borderBottomWidth: strokeWidth,
          borderColor: ink,
          borderTopLeftRadius: width * 0.55,
          borderBottomLeftRadius: width * 0.55,
        }}
      />
      {/* Gate side (right) — standard weight */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: width * 0.52,
          height: height,
          borderRightWidth: strokeWidth,
          borderTopWidth: strokeWidth,
          borderBottomWidth: strokeWidth,
          borderColor: ink,
          borderTopRightRadius: width * 0.32,
          borderBottomRightRadius: width * 0.32,
        }}
      />
      {/* Gate bar — heavier bar at the top where rope clips in */}
      <View
        style={{
          position: 'absolute',
          top: height * 0.18,
          right: -strokeWidth * 0.3,
          width: width * 0.36,
          height: gateWeight,
          borderRadius: gateWeight / 2,
          backgroundColor: ink,
          transform: [{ rotate: '-8deg' }],
        }}
      />
      {/* Screw-gate detail - small circular lock */}
      <View
        style={{
          position: 'absolute',
          top: height * 0.12,
          right: width * 0.38,
          width: strokeWidth * 1.2,
          height: strokeWidth * 1.2,
          borderRadius: strokeWidth * 0.6,
          // The lock reads against the page, not against a white rim: `bg` is
          // the ground it is actually drawn on in both appearances.
          backgroundColor: ink,
          borderWidth: 0.5,
          borderColor: theme.colors.bg,
        }}
      />
    </View>
  );
}
