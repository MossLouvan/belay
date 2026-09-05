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
 * Realistic climbing carabiner with 3D depth and metallic appearance.
 * D-shaped offset body with visible gate, highlights, and shadows to create
 * dimension. The spine (left side) is wider and more rounded than the gate
 * side (right), matching actual climbing hardware.
 */
export function Carabiner({ size = 40, color, strokeWidth = 3 }: CarabinerProps) {
  const theme = useTheme();
  const ink = color ?? theme.colors.accentGraphic;
  const width = size;
  const height = size * 1.3;
  const gateWeight = strokeWidth + 1.5;

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
          borderTopLeftRadius: width * 0.55,
          borderBottomLeftRadius: width * 0.55,
          borderTopRightRadius: width * 0.32,
          borderBottomRightRadius: width * 0.32,
        }}
      />
      {/* Inner highlight for metallic shine (top-left) */}
      <View
        style={{
          position: 'absolute',
          top: strokeWidth * 0.5,
          left: strokeWidth * 0.5,
          width: width * 0.22,
          height: height * 0.35,
          borderTopLeftRadius: width * 0.5,
          backgroundColor: 'rgba(255, 255, 255, 0.25)',
          borderWidth: 0,
        }}
      />
      {/* Gate opening gap (right side, top third) */}
      <View
        style={{
          position: 'absolute',
          top: height * 0.22,
          right: -strokeWidth * 0.5,
          width: strokeWidth * 1.5,
          height: height * 0.15,
          backgroundColor: theme.colors.bg,
        }}
      />
      {/* Gate bar — heavier bar at the top where rope clips in */}
      <View
        style={{
          position: 'absolute',
          top: height * 0.18,
          right: -strokeWidth * 0.5,
          width: width * 0.36,
          height: gateWeight,
          borderRadius: gateWeight / 2,
          backgroundColor: ink,
          transform: [{ rotate: '-8deg' }],
        }}
      />
      {/* Gate highlight for metallic appearance */}
      <View
        style={{
          position: 'absolute',
          top: height * 0.18,
          right: width * 0.08,
          width: width * 0.16,
          height: gateWeight * 0.5,
          borderRadius: gateWeight / 2,
          backgroundColor: 'rgba(255, 255, 255, 0.4)',
          transform: [{ rotate: '-8deg' }],
        }}
      />
      {/* Spine thickness emphasis (bottom left) */}
      <View
        style={{
          position: 'absolute',
          bottom: height * 0.3,
          left: strokeWidth * 0.2,
          width: width * 0.18,
          height: height * 0.25,
          borderBottomLeftRadius: width * 0.5,
          borderTopLeftRadius: width * 0.5,
          backgroundColor: 'rgba(0, 0, 0, 0.1)',
          borderWidth: 0,
        }}
      />
    </View>
  );
}
