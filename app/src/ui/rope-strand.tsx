// Shared rope rendering with helical braid pattern — actual climbing rope texture.
//
// Climbing ropes have twisted/braided construction visible as diagonal patterns
// wrapping around the core. Short staggered highlight dashes create this helical
// read without needing complex path rendering. Used across splash (curved),
// setup/pull (straight), and notifications.
//
// Fiber optic flow: gentle traveling highlights and discrete data packets move
// along the rope to convey live connectivity (phone↔PC data link). Respects
// reduced motion by freezing all flow when accessibility preferences require it.

import React, { useEffect } from 'react';
import { View, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  withDelay,
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
  /** For curved ropes: render as border on circle. Requires circleRadius. */
  readonly curved?: boolean;
  /** Circle radius for curved rope (splash screen arc) */
  readonly circleRadius?: number;
  /** Circle center offset for curved rope */
  readonly circleCenter?: { x: number; y: number };
  /** Enable fiber optic flow and data packet animations (default: true) */
  readonly enableFlow?: boolean;
}

/**
 * Curved rope strand for splash screen with fiber optic flow along the arc.
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
  // Data packets traveling along the curved arc - SUBTLE
  const packet1 = useSharedValue(0);
  const packet2 = useSharedValue(0);
  const packet3 = useSharedValue(0);

  useEffect(() => {
    if (!shouldAnimate) {
      // Reduced motion: no traveling packets
      packet1.value = 0;
      packet2.value = 0;
      packet3.value = 0;
      return;
    }

    const packetDuration = 3800; // Slower, more gentle
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

  // Convert packet progress to angle position along arc (180deg arc from left to right)
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
        opacity: 0.22, // SUBTLE - not bright
        position: 'absolute',
        left: x - width * 0.25, // Tighter to rope strand
        top: y - width * 0.7,
      };
    });
  };

  const packet1Style = getPacketStyle(packet1);
  const packet2Style = getPacketStyle(packet2);
  const packet3Style = getPacketStyle(packet3);

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

      {/* Data packets traveling along the curved arc — sparse, subtle, clipped to strand */}
      {shouldAnimate && (
        <>
          <Animated.View
            style={[
              packet1Style,
              {
                width: width * 0.5, // Smaller, subtle
                height: width * 1.4,
                borderRadius: width * 0.25,
                backgroundColor: color, // Belay blue tint
                shadowColor: color,
                shadowRadius: width * 0.3,
                shadowOpacity: 0.2, // Very subtle glow
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
 * Braided climbing rope with helical strand pattern and fiber optic flow.
 * Renders shadow + main body + staggered highlight dashes that suggest
 * twisted construction, avoiding the "parallel tube" read of full-length strips.
 * 
 * Flow effects: gentle traveling light pulses along the rope with discrete
 * data packet elements that travel along the path, creating a live data-link
 * aesthetic (phone↔PC connectivity).
 */
export function RopeStrand({ 
  width, 
  color, 
  animatedStyle, 
  curved = false, 
  circleRadius, 
  circleCenter,
  enableFlow = true,
}: RopeStrandProps) {
  const reducedMotion = useReducedMotion();
  const shouldAnimate = enableFlow && !reducedMotion;

  if (curved && circleRadius && circleCenter) {
    // Curved rope for splash screen — data packets travel along the arc
    return <CurvedRopeStrand 
      width={width}
      color={color}
      animatedStyle={animatedStyle}
      circleRadius={circleRadius}
      circleCenter={circleCenter}
      shouldAnimate={shouldAnimate}
    />;
  }

  // Straight rope with helical dashes and fiber optic flow
  const dashCount = 8;
  const dashHeight = width * 2.5;
  const dashGap = width * 1.5;

  // Data packet animations - 3 sparse packets with staggered timing (SUBTLE)
  const packet1 = useSharedValue(0);
  const packet2 = useSharedValue(0);
  const packet3 = useSharedValue(0);
  const flowGlow = useSharedValue(shouldAnimate ? 0 : 0.3); // Static bloom for reduced motion

  useEffect(() => {
    if (!shouldAnimate) {
      // Reduced motion: static soft bloom, no traveling packets
      packet1.value = 0;
      packet2.value = 0;
      packet3.value = 0;
      flowGlow.value = 0.3; // Static subtle glow
      return;
    }

    // Continuous flow: sparse packets travel down the rope at staggered intervals
    const packetDuration = 2800; // Slower, more gentle
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

    // Gentle flowing glow effect - very subtle
    flowGlow.value = withRepeat(
      withTiming(1, { duration: 3500, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [shouldAnimate, packet1, packet2, packet3, flowGlow]);

  // Animated styles for data packets - SUBTLE opacity
  const packet1Style = useAnimatedStyle(() => ({
    opacity: packet1.value > 0 && packet1.value < 0.95 ? 0.25 : 0,
    transform: [{ translateY: packet1.value * 100 }],
  }));

  const packet2Style = useAnimatedStyle(() => ({
    opacity: packet2.value > 0 && packet2.value < 0.95 ? 0.2 : 0,
    transform: [{ translateY: packet2.value * 100 }],
  }));

  const packet3Style = useAnimatedStyle(() => ({
    opacity: packet3.value > 0 && packet3.value < 0.95 ? 0.22 : 0,
    transform: [{ translateY: packet3.value * 100 }],
  }));

  // Flow glow style - very low amplitude, Belay blue core
  const flowGlowStyle = useAnimatedStyle(() => ({
    opacity: shouldAnimate ? flowGlow.value * 0.05 + 0.02 : 0.03, // Static bloom or gentle pulse
  }));

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
      
      {/* Fiber optic flow glow — soft traveling light along the braid core, Belay blue */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: width * 0.9, // Narrower to stay within strand
            borderRadius: width * 0.45,
            backgroundColor: color, // Belay blue / accentGraphic
            shadowColor: color,
            shadowRadius: width * 0.6,
            shadowOpacity: 0.15, // Very subtle
          },
          animatedStyle,
          flowGlowStyle,
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

      {/* Data packets — sparse bright dashes drifting along rope (2-3 visible), clipped to strand */}
      {shouldAnimate && (
        <>
          <Animated.View
            style={[
              {
                position: 'absolute',
                top: 0,
                width: width * 0.5, // Smaller, subtle
                height: width * 1.4,
                borderRadius: width * 0.25,
                backgroundColor: color, // Belay blue tint
                shadowColor: color,
                shadowRadius: width * 0.3,
                shadowOpacity: 0.2, // Very subtle glow
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
