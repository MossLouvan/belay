// Shared rope rendering with helical braid pattern — actual climbing rope texture.
//
// Climbing ropes have twisted/braided construction visible as diagonal patterns
// wrapping around the core. Short staggered highlight dashes create this helical
// read without needing complex path rendering. Used across splash (curved),
// setup/pull (straight), and notifications.

import React from 'react';
import { View, ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

export interface RopeStrandProps {
  /** Rope thickness in points */
  readonly width: number;
  /** Rope color (typically theme.colors.accentGraphic) */
  readonly color: string;
  /** Optional animated style for height/position (Reanimated) */
  readonly animatedStyle?: any;
  /** For curved ropes: render as border on circle. Requires circleRadius. */
  readonly curved?: boolean;
  /** Circle radius for curved rope (splash screen arc) */
  readonly circleRadius?: number;
  /** Circle center offset for curved rope */
  readonly circleCenter?: { x: number; y: number };
}

/**
 * Braided climbing rope with helical strand pattern.
 * Renders shadow + main body + staggered highlight dashes that suggest
 * twisted construction, avoiding the "parallel tube" read of full-length strips.
 */
export function RopeStrand({ width, color, animatedStyle, curved = false, circleRadius, circleCenter }: RopeStrandProps) {
  if (curved && circleRadius && circleCenter) {
    // Curved rope for splash screen (rendered as circle borders)
    return (
      <View style={[{ position: 'relative' }, animatedStyle]} pointerEvents="none">
        {/* Shadow layer */}
        <View
          style={{
            position: 'absolute',
            left: circleCenter.x - circleRadius,
            top: circleCenter.y - circleRadius * 2 + 2,
            width: circleRadius * 2,
            height: circleRadius * 2,
            borderRadius: circleRadius,
            borderWidth: width,
            borderColor: 'rgba(0, 0, 0, 0.2)',
          }}
        />
        {/* Main rope body */}
        <View
          style={{
            position: 'absolute',
            left: circleCenter.x - circleRadius,
            top: circleCenter.y - circleRadius * 2,
            width: circleRadius * 2,
            height: circleRadius * 2,
            borderRadius: circleRadius,
            borderWidth: width,
            borderColor: color,
          }}
        />
        {/* Helical highlight pattern — offset circles create braid read */}
        <View
          style={{
            position: 'absolute',
            left: circleCenter.x - circleRadius + width * 0.3,
            top: circleCenter.y - circleRadius * 2 - width * 0.2,
            width: circleRadius * 2,
            height: circleRadius * 2,
            borderRadius: circleRadius,
            borderWidth: width * 0.25,
            borderColor: 'rgba(255, 255, 255, 0.35)',
          }}
        />
        <View
          style={{
            position: 'absolute',
            left: circleCenter.x - circleRadius - width * 0.25,
            top: circleCenter.y - circleRadius * 2 + width * 0.3,
            width: circleRadius * 2,
            height: circleRadius * 2,
            borderRadius: circleRadius,
            borderWidth: width * 0.2,
            borderColor: 'rgba(255, 255, 255, 0.2)',
          }}
        />
      </View>
    );
  }

  // Straight rope with helical dashes
  const dashCount = 8; // Staggered dashes along the rope
  const dashHeight = width * 2.5;
  const dashGap = width * 1.5;

  return (
    <View style={{ position: 'relative', alignItems: 'center' }} pointerEvents="none">
      {/* Shadow for depth */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 1,
            width: width,
            borderRadius: width / 2,
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
          },
          animatedStyle,
        ]}
      />
      {/* Main rope body */}
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
      {/* Helical braid highlights — staggered dashes spiraling along rope */}
      {Array.from({ length: dashCount }).map((_, i) => {
        const offset = i * (dashHeight + dashGap);
        const side = i % 2 === 0 ? width * 0.2 : -width * 0.15;
        return (
          <Animated.View
            key={`dash-${i}`}
            style={[
              {
                position: 'absolute',
                top: offset,
                left: side,
                width: width * 0.4,
                height: dashHeight,
                borderRadius: width * 0.2,
                backgroundColor: i % 2 === 0 ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.22)',
              },
              animatedStyle,
            ]}
          />
        );
      })}
    </View>
  );
}
