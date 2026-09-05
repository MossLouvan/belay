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
  /** For curved ropes: render as arc. Requires circleRadius. */
  readonly curved?: boolean;
  /** Circle radius for curved rope (splash screen arc) */
  readonly circleRadius?: number;
  /** Circle center offset for curved rope */
  readonly circleCenter?: { x: number; y: number };
}

/**
 * Curved rope strand for splash screen with helical dashes along the arc + fiber flow.
 */
function CurvedRopeStrand({
  width,
  color,
  animatedStyle,
  circleRadius,
  circleCenter,
  shouldAnimate,
}: {
  width: number;
  color: string;
  animatedStyle: any;
  circleRadius: number;
  circleCenter: { x: number; y: number };
  shouldAnimate: boolean;
}) {
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

      // Map 0->1 to angle 180deg -> 0deg (traveling clockwise along bottom arc)
      const angle = Math.PI * (1 - progress);
      const x = circleCenter.x + Math.cos(angle) * circleRadius;
      const y = circleCenter.y - circleRadius * 2 + Math.sin(angle) * circleRadius;

      return {
        opacity: 0.22, // SUBTLE
        position: 'absolute',
        left: x - width * 0.25,
        top: y - width * 0.7,
      };
    });
  };

  const packet1Style = getPacketStyle(packet1);
  const packet2Style = getPacketStyle(packet2);
  const packet3Style = getPacketStyle(packet3);

  // Helical dashes along the arc (not concentric rings)
  const dashCount = Math.floor((Math.PI * circleRadius) / (width * 3)); // Space along arc
  const helicalDashes = Array.from({ length: dashCount }).map((_, i) => {
    // Position along 180° arc from left to right
    const angleProgress = i / dashCount;
    const angle = Math.PI * (1 - angleProgress); // 180° to 0°
    
    const x = circleCenter.x + Math.cos(angle) * circleRadius;
    const y = circleCenter.y - circleRadius * 2 + Math.sin(angle) * circleRadius;
    
    // Alternate sides for helical spiral
    const side = i % 2 === 0 ? 1 : -1;
    const offsetX = side * width * 0.15;
    const offsetY = side * width * 0.1;
    
    // Rotate dash to be tangent to arc
    const tangentAngle = angle - Math.PI / 2; // Perpendicular to radius
    const tiltDeg = (tangentAngle * 180 / Math.PI) + (side * 15); // Add spiral tilt
    
    return {
      key: `dash-${i}`,
      x: x + offsetX,
      y: y + offsetY,
      rotation: tiltDeg,
      opacity: i % 2 === 0 ? 0.4 : 0.25,
    };
  });

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
      
      {/* Helical braid dashes along the arc (not concentric rings) */}
      {helicalDashes.map((dash) => (
        <View
          key={dash.key}
          style={{
            position: 'absolute',
            left: dash.x - width * 0.2,
            top: dash.y - width * 0.6,
            width: width * 0.4,
            height: width * 1.2,
            borderRadius: width * 0.2,
            backgroundColor: `rgba(255, 255, 255, ${dash.opacity})`,
            transform: [{ rotate: `${dash.rotation}deg` }],
          }}
        />
      ))}

      {/* Data packets — sparse, clipped to arc */}
      {shouldAnimate && (
        <>
          <Animated.View
            style={[
              packet1Style,
              {
                width: width * 0.5,
                height: width * 1.4,
                borderRadius: width * 0.25,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: width * 0.3,
                shadowOpacity: 0.2,
              },
            ]}
          />
          <Animated.View
            style={[
              packet2Style,
              {
                width: width * 0.45,
                height: width * 1.2,
                borderRadius: width * 0.225,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: width * 0.25,
                shadowOpacity: 0.18,
              },
            ]}
          />
          <Animated.View
            style={[
              packet3Style,
              {
                width: width * 0.48,
                height: width * 1.3,
                borderRadius: width * 0.24,
                backgroundColor: color,
                shadowColor: color,
                shadowRadius: width * 0.28,
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
  curved = false,
  circleRadius,
  circleCenter,
}: RopeStrandProps) {
  const reducedMotion = useReducedMotion();
  const shouldAnimate = enableFlow && !reducedMotion;

  // Curved rope for splash screen
  if (curved && circleRadius && circleCenter) {
    return <CurvedRopeStrand 
      width={width}
      color={color}
      animatedStyle={animatedStyle}
      circleRadius={circleRadius}
      circleCenter={circleCenter}
      shouldAnimate={shouldAnimate}
    />;
  }

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
