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
 * Realistic climbing carabiner with forged aluminum appearance.
 * D-shaped offset body with visible gate, thin specular highlights along edges,
 * and proper spine mass. The spine (left side) has thicker stroke weight than
 * the gate side (right), matching actual climbing hardware.
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
      {/* Shadow layer for depth */}
      <View
        style={{
          position: 'absolute',
          top: 1,
          left: 1,
          right: -1,
          bottom: -1,
          borderWidth: strokeWidth,
          borderColor: 'rgba(0, 0, 0, 0.15)',
          borderTopLeftRadius: width * 0.55,
          borderBottomLeftRadius: width * 0.55,
          borderTopRightRadius: width * 0.32,
          borderBottomRightRadius: width * 0.32,
        }}
      />
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
      {/* Thin specular highlight along spine edge (forged aluminum shine) */}
      <View
        style={{
          position: 'absolute',
          top: strokeWidth,
          left: strokeWidth + 1,
          width: 1,
          height: height * 0.6,
          backgroundColor: 'rgba(255, 255, 255, 0.5)',
          borderRadius: 0.5,
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
      {/* Sharp gate highlight (tube edge catch-light) */}
      <View
        style={{
          position: 'absolute',
          top: height * 0.18 + gateWeight * 0.1,
          right: width * 0.12,
          width: width * 0.14,
          height: 1,
          backgroundColor: 'rgba(255, 255, 255, 0.6)',
          transform: [{ rotate: '-8deg' }],
        }}
      />
    </View>
  );
}
