// Shared rope rendering with electric fiber-optic helical braid pattern.
//
// Real climbing rope construction: braided/twisted strands spiraling around
// the core with dark recesses between peaks. Self-lit electric blue with soft
// bloom halo. Used across splash (curved), pull/setup (straight), and
// notifications. Single canonical recipe — no duplicate implementations.

import React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

export interface RopeStrandProps {
  /** Rope thickness in points */
  readonly width: number;
  /** Rope color (typically theme.colors.accentGraphic) */
  readonly color: string;
  /** Optional animated style for height/position (Reanimated) */
  readonly animatedStyle?: any;
  /** Current height for straight ropes (affects dash clipping) */
  readonly currentHeight?: number;
}

/**
 * Electric fiber-optic climbing rope with helical braided strand pattern.
 * 
 * Renders:
 * - Soft bloom glow layers (self-lit appearance on dark backgrounds)
 * - Main rope core body
 * - Tilted spiral dashes showing helical twist with dark recesses between peaks
 * - Shadow for depth
 * 
 * Never parallel gloss strips or concentric glow rings.
 */
export function RopeStrand({ width, color, animatedStyle, currentHeight }: RopeStrandProps) {
  const dashHeight = width * 2.5;
  const dashGap = width * 1.5;
  const totalSegment = dashHeight + dashGap;
  
  // Calculate visible dash count based on current rope height
  const height = currentHeight ?? 120; // Default for static usage
  const visibleDashCount = Math.floor(height / totalSegment);

  return (
    <View style={{ position: 'relative', alignItems: 'center' }} pointerEvents="none">
      {/* Outer glow/bloom layers for fiber-optic self-lit effect */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: width * 3.5,
            borderRadius: width * 1.75,
            backgroundColor: `${color}12`,
          },
          animatedStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: width * 2,
            borderRadius: width,
            backgroundColor: `${color}35`,
          },
          animatedStyle,
        ]}
      />
      {/* Shadow for depth */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 1,
            width: width,
            borderRadius: width / 2,
            backgroundColor: 'rgba(0, 0, 0, 0.2)',
          },
          animatedStyle,
        ]}
      />
      {/* Main rope body - electric blue core */}
      <Animated.View
        style={[
          {
            width,
            borderRadius: width / 2,
            backgroundColor: color,
          },
          animatedStyle,
        ]}
      />
      {/* Helical braid: tilted spiral dashes wrapping the core with dark recesses */}
      {Array.from({ length: visibleDashCount }).map((_, i) => {
        const yPos = i * totalSegment;
        const side = i % 2 === 0 ? 1 : -1;
        const xOffset = side * width * 0.15;
        const tiltAngle = side * 30; // ~30° tilt alternating left/right for spiral read
        const dashOpacity = i % 2 === 0 ? 0.65 : 0.45;
        const clippedHeight = Math.min(dashHeight, height - yPos);
        
        return (
          <React.Fragment key={`dash-${i}`}>
            {/* Dash glow halo */}
            <View
              style={{
                position: 'absolute',
                top: yPos,
                left: xOffset,
                width: width * 0.9,
                height: clippedHeight,
                borderRadius: width * 0.45,
                backgroundColor: `rgba(255, 255, 255, ${dashOpacity * 0.2})`,
                transform: [{ rotate: `${tiltAngle}deg` }],
                overflow: 'hidden',
              }}
            />
            {/* Dash core - bright strand highlight (peaks between dark recesses) */}
            <View
              style={{
                position: 'absolute',
                top: yPos,
                left: xOffset,
                width: width * 0.4,
                height: clippedHeight,
                borderRadius: width * 0.2,
                backgroundColor: `rgba(255, 255, 255, ${dashOpacity})`,
                transform: [{ rotate: `${tiltAngle}deg` }],
                overflow: 'hidden',
              }}
            />
          </React.Fragment>
        );
      })}
    </View>
  );
}

/**
 * Curved rope segment for splash screen (rendered as arc).
 * Same helical braid pattern, adapted for circular path.
 */
export function CurvedRopeStrand({
  width,
  height,
  color,
  ropeStroke = 6,
}: {
  width: number;
  height: number;
  color: string;
  ropeStroke?: number;
}) {
  const startY = height * 0.15;
  const sagY = height * 0.45;
  const sag = sagY - startY;
  const halfSpan = width / 2;
  const radius = (halfSpan * halfSpan + sag * sag) / (2 * sag);
  const centerX = width / 2;
  const centerY = sagY - radius;

  // Calculate dashes along the arc
  const dashCount = 14;
  const dashWidth = ropeStroke * 0.4;
  const dashHeight = ropeStroke * 2.5;
  const arcSpan = Math.atan2(halfSpan, radius - sag) * 2;

  return (
    <View style={{ position: 'absolute', width, height }} pointerEvents="none">
      {/* Outer glow/bloom layers */}
      <View
        style={{
          position: 'absolute',
          left: centerX - radius,
          top: centerY,
          width: radius * 2,
          height: radius * 2,
          borderRadius: radius,
          borderWidth: ropeStroke * 3,
          borderColor: `${color}15`,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: centerX - radius,
          top: centerY,
          width: radius * 2,
          height: radius * 2,
          borderRadius: radius,
          borderWidth: ropeStroke * 1.8,
          borderColor: `${color}40`,
        }}
      />
      {/* Shadow layer */}
      <View
        style={{
          position: 'absolute',
          left: centerX - radius,
          top: centerY + 2,
          width: radius * 2,
          height: radius * 2,
          borderRadius: radius,
          borderWidth: ropeStroke,
          borderColor: 'rgba(0, 0, 0, 0.25)',
        }}
      />
      {/* Main rope body - electric blue core */}
      <View
        style={{
          position: 'absolute',
          left: centerX - radius,
          top: centerY,
          width: radius * 2,
          height: radius * 2,
          borderRadius: radius,
          borderWidth: ropeStroke,
          borderColor: color,
        }}
      />
      {/* Helical braid pattern — staggered glowing dashes along the arc */}
      {Array.from({ length: dashCount }).map((_, i) => {
        const t = i / (dashCount - 1);
        const angle = -Math.PI / 2 - arcSpan / 2 + arcSpan * t;
        
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);
        
        const side = i % 2 === 0 ? 1 : -1;
        const offset = side * ropeStroke * 0.25;
        
        const perpAngle = angle + Math.PI / 2;
        const dashX = x + offset * Math.cos(perpAngle);
        const dashY = y + offset * Math.sin(perpAngle);
        
        const tangentAngle = angle + Math.PI / 2;
        const rotateDeg = (tangentAngle * 180) / Math.PI;
        const dashOpacity = i % 2 === 0 ? 0.65 : 0.45;
        
        return (
          <React.Fragment key={`dash-${i}`}>
            {/* Dash glow halo */}
            <View
              style={{
                position: 'absolute',
                left: dashX - dashWidth,
                top: dashY - dashHeight,
                width: dashWidth * 2,
                height: dashHeight * 2,
                borderRadius: dashWidth,
                backgroundColor: `rgba(255, 255, 255, ${dashOpacity * 0.15})`,
                transform: [{ rotate: `${rotateDeg}deg` }],
              }}
            />
            {/* Dash core */}
            <View
              style={{
                position: 'absolute',
                left: dashX - dashWidth / 2,
                top: dashY - dashHeight / 2,
                width: dashWidth,
                height: dashHeight,
                borderRadius: dashWidth / 2,
                backgroundColor: `rgba(255, 255, 255, ${dashOpacity})`,
                transform: [{ rotate: `${rotateDeg}deg` }],
              }}
            />
          </React.Fragment>
        );
      })}
    </View>
  );
}
