// Shared rope rendering with electric fiber-optic helical braid pattern + data flow.
//
// Real climbing rope construction: braided/twisted strands spiraling around
// the core with dark recesses between peaks. Self-lit electric blue with soft
// bloom halo + subtle data packets drifting along (phone↔PC connectivity).
// Used across splash (curved), pull/setup (straight), and notifications.

import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withDelay,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { useReducedMotion } from './motion';

export interface RopeStrandProps {
  /** Rope thickness in points */
  readonly width: number;
  /** Rope color (typically theme.colors.accentGraphic) */
  readonly color: string;
  /** Optional animated style for height/position (Reanimated) */
  readonly animatedStyle?: any;
  /** Current height for straight ropes (affects dash clipping and packet travel) */
  readonly currentHeight?: number;
  /** Enable fiber optic flow and data packet animations (default: true) */
  readonly enableFlow?: boolean;
}

/**
 * Curved rope strand for splash screen with helical dashes along the arc + fiber flow.
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
  const reducedMotion = useReducedMotion();
  const shouldAnimate = !reducedMotion;

  // Calculate circle parameters from width/height
  const startY = height * 0.15;
  const sagY = height * 0.45;
  const sag = sagY - startY;
  const halfSpan = width / 2;
  const radius = (halfSpan * halfSpan + sag * sag) / (2 * sag);
  const centerX = width / 2;
  const centerY = sagY - radius;

  // Data packets traveling along the curved arc - SUBTLE (2-3 visible)
  const packet1 = useSharedValue(0);
  const packet2 = useSharedValue(0);
  const packet3 = useSharedValue(0);

  useEffect(() => {
    if (!shouldAnimate) {
      packet1.value = 0;
      packet2.value = 0;
      packet3.value = 0;
      return;
    }

    // Slower timing for gentle flow
    const packetDuration = 3800;
    packet1.value = withRepeat(
      withTiming(1, { duration: packetDuration, easing: Easing.linear }),
      -1,
      false
    );
    packet2.value = withDelay(
      1200,
      withRepeat(
        withTiming(1, { duration: packetDuration, easing: Easing.linear }),
        -1,
        false
      )
    );
    packet3.value = withDelay(
      2400,
      withRepeat(
        withTiming(1, { duration: packetDuration, easing: Easing.linear }),
        -1,
        false
      )
    );
  }, [shouldAnimate, packet1, packet2, packet3]);

  // Packet position along arc
  const getPacketStyle = (packetValue: SharedValue<number>) => {
    return useAnimatedStyle(() => {
      const progress = packetValue.value;
      if (progress === 0 || progress > 0.95) {
        return { opacity: 0 };
      }

      // Map 0->1 along the arc
      const arcSpan = Math.atan2(halfSpan, radius - sag) * 2;
      const angle = -Math.PI / 2 - arcSpan / 2 + arcSpan * progress;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);

      return {
        opacity: 0.22, // SUBTLE
        position: 'absolute',
        left: x - ropeStroke * 0.3,
        top: y - ropeStroke * 0.7,
      };
    });
  };

  const packet1Style = getPacketStyle(packet1);
  const packet2Style = getPacketStyle(packet2);
  const packet3Style = getPacketStyle(packet3);

  // Helical dashes along the arc (not concentric rings)
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
      
      {/* Helical braid dashes along the arc (not concentric rings) */}
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
                left: dashX - dashWidth * 0.75,
                top: dashY - dashHeight / 2,
                width: dashWidth * 1.5,
                height: dashHeight,
                borderRadius: dashWidth * 0.75,
                backgroundColor: `rgba(255, 255, 255, ${dashOpacity * 0.3})`,
                transform: [{ rotate: `${rotateDeg}deg` }],
              }}
            />
            {/* Solid dash core */}
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

      {/* Data packets — sparse, clipped to arc */}
      {shouldAnimate && (
        <>
          <Animated.View
            style={[
              packet1Style,
              {
                width: ropeStroke * 0.8,
                height: ropeStroke * 2.2,
                borderRadius: ropeStroke * 0.4,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: ropeStroke * 0.5,
                shadowOpacity: 0.2,
              },
            ]}
          />
          <Animated.View
            style={[
              packet2Style,
              {
                width: ropeStroke * 0.7,
                height: ropeStroke * 1.9,
                borderRadius: ropeStroke * 0.35,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: ropeStroke * 0.4,
                shadowOpacity: 0.18,
              },
            ]}
          />
          <Animated.View
            style={[
              packet3Style,
              {
                width: ropeStroke * 0.75,
                height: ropeStroke * 2.1,
                borderRadius: ropeStroke * 0.375,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: ropeStroke * 0.45,
                shadowOpacity: 0.19,
              },
            ]}
          />
        </>
      )}
    </View>
  );
}

/**
 * Electric fiber-optic climbing rope with helical braided strand pattern + data flow.
 * 
 * Renders:
 * - Soft bloom glow layers (self-lit appearance on dark backgrounds)
 * - Main rope core body
 * - Tilted spiral dashes showing helical twist (~30° alternating)
 * - Shadow for depth
 * - SUBTLE data packets drifting along (2-3 visible, ~0.2 opacity)
 * - Gentle flowing light pulse (reduced motion: static bloom)
 */
export function RopeStrand({ 
  width, 
  color, 
  animatedStyle, 
  currentHeight,
  enableFlow = true,
}: RopeStrandProps) {
  const reducedMotion = useReducedMotion();
  const shouldAnimate = enableFlow && !reducedMotion;

  // Straight rope with tilted dashes and fiber flow
  const dashHeight = width * 2.5;
  const dashGap = width * 1.5;
  const totalSegment = dashHeight + dashGap;
  
  // Calculate visible dash count based on current rope height
  const height = currentHeight ?? 120; // Default for static usage
  const visibleDashCount = Math.floor(height / totalSegment);

  // Data packet animations - 3 sparse packets, scaled to actual rope height
  const packet1 = useSharedValue(0);
  const packet2 = useSharedValue(0);
  const packet3 = useSharedValue(0);
  const flowGlow = useSharedValue(shouldAnimate ? 0 : 0.3);

  useEffect(() => {
    if (!shouldAnimate) {
      // Reduced motion: static soft bloom
      packet1.value = 0;
      packet2.value = 0;
      packet3.value = 0;
      flowGlow.value = 0.3;
      return;
    }

    // Packets travel the full rope height
    const packetDuration = 2800;
    packet1.value = withRepeat(
      withTiming(1, { duration: packetDuration, easing: Easing.linear }),
      -1,
      false
    );
    packet2.value = withDelay(
      900,
      withRepeat(
        withTiming(1, { duration: packetDuration, easing: Easing.linear }),
        -1,
        false
      )
    );
    packet3.value = withDelay(
      1800,
      withRepeat(
        withTiming(1, { duration: packetDuration, easing: Easing.linear }),
        -1,
        false
      )
    );

    // Gentle flowing glow
    flowGlow.value = withRepeat(
      withTiming(1, { duration: 3500, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [shouldAnimate, height, packet1, packet2, packet3, flowGlow]);

  // Packet styles - travel full height
  const packet1Style = useAnimatedStyle(() => ({
    opacity: packet1.value > 0 && packet1.value < 0.95 ? 0.25 : 0,
    transform: [{ translateY: packet1.value * height }],
  }));

  const packet2Style = useAnimatedStyle(() => ({
    opacity: packet2.value > 0 && packet2.value < 0.95 ? 0.2 : 0,
    transform: [{ translateY: packet2.value * height }],
  }));

  const packet3Style = useAnimatedStyle(() => ({
    opacity: packet3.value > 0 && packet3.value < 0.95 ? 0.22 : 0,
    transform: [{ translateY: packet3.value * height }],
  }));

  const flowGlowStyle = useAnimatedStyle(() => ({
    opacity: shouldAnimate ? flowGlow.value * 0.05 + 0.02 : 0.03,
  }));

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
      
      {/* Fiber optic flow glow — soft traveling light */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: width * 0.9,
            borderRadius: width * 0.45,
            backgroundColor: color,
            shadowColor: color,
            shadowRadius: width * 0.6,
            shadowOpacity: 0.15,
          },
          animatedStyle,
          flowGlowStyle,
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
                width: width * 0.6,
                height: clippedHeight,
                borderRadius: width * 0.3,
                backgroundColor: `rgba(255, 255, 255, ${dashOpacity * 0.3})`,
                transform: [{ rotate: `${tiltAngle}deg` }],
              }}
            />
            {/* Solid dash core */}
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
              }}
            />
          </React.Fragment>
        );
      })}

      {/* Data packets — sparse bright dashes drifting along rope (2-3 visible) */}
      {shouldAnimate && (
        <>
          <Animated.View
            style={[
              {
                position: 'absolute',
                top: 0,
                width: width * 0.5,
                height: width * 1.4,
                borderRadius: width * 0.25,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: width * 0.3,
                shadowOpacity: 0.2,
              },
              packet1Style,
            ]}
          />
          <Animated.View
            style={[
              {
                position: 'absolute',
                top: 0,
                width: width * 0.45,
                height: width * 1.2,
                borderRadius: width * 0.225,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: width * 0.25,
                shadowOpacity: 0.18,
              },
              packet2Style,
            ]}
          />
          <Animated.View
            style={[
              {
                position: 'absolute',
                top: 0,
                width: width * 0.48,
                height: width * 1.3,
                borderRadius: width * 0.24,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: width * 0.28,
                shadowOpacity: 0.19,
              },
              packet3Style,
            ]}
          />
        </>
      )}
    </View>
  );
}
