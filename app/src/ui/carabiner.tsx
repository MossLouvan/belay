// The carabiner mark — Belay's brand glyph, drawn once.
//
// The same D-shaped clip hangs off the splash rope, drops in with
// notifications, and now anchors the Tailscale setup rope. It used to be
// drawn separately in each of those files, which is exactly how a brand mark
// drifts: three copies, three stroke weights, three slightly different gates.
// One drawing here; every rope clips onto it.

import React from 'react';
import Svg, { Line, Path } from 'react-native-svg';

export interface CarabinerProps {
  /** Width in points; the clip is drawn about 1.3× taller than wide. */
  readonly size?: number;
  /** Stroke colour — usually `theme.colors.accentGraphic`. */
  readonly color: string;
  /** Stroke weight. The gate is always drawn a touch heavier so it reads. */
  readonly strokeWidth?: number;
}

/**
 * Simplified D-shaped climbing carabiner: a rounded spine on the left, a
 * shallower arc on the right, and a short heavier line for the gate. Scales
 * cleanly because everything is derived from `size`.
 */
export function Carabiner({ size = 40, color, strokeWidth = 3 }: CarabinerProps) {
  const width = size;
  const height = size * 1.3;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {/* Main D-shape body */}
      <Path
        d={`
          M ${width * 0.3} ${strokeWidth * 2}
          L ${width * 0.7} ${strokeWidth * 2}
          A ${width * 0.25} ${width * 0.25} 0 0 1 ${width * 0.7} ${height - strokeWidth * 2}
          L ${width * 0.3} ${height - strokeWidth * 2}
          A ${width * 0.3} ${height * 0.45} 0 0 1 ${width * 0.3} ${strokeWidth * 2}
        `}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Gate — the small break at the top where the rope clips in */}
      <Line
        x1={width * 0.35}
        y1={strokeWidth * 2}
        x2={width * 0.5}
        y2={strokeWidth * 2}
        stroke={color}
        strokeWidth={strokeWidth + 1}
        strokeLinecap="round"
      />
    </Svg>
  );
}
