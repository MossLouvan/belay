// Blue rope + carabiner brand splash — the startup composition.
//
// Black canvas, blue curved rope hanging from top, carabiner at sag point,
// BELAY wordmark + tagline bottom-right. Animated sequence: rope drops →
// carabiner slides in → wordmark fades up. Matches reference composition
// exactly but with blue (accent) rope instead of orange.

import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../theme';
import { Txt, Micro, useReducedMotion } from '../ui';
import { Carabiner } from '../ui/carabiner';
import { SPRING_CONFIGS } from '../ui/motion';

interface RopeSplashProps {
  /** Whether to play the animation. Set false for reduced motion instant display. */
  animated?: boolean;
}

/**
 * Curved rope using SVG Path — hangs from left and right edges,
 * sags in the middle where the carabiner clips on.
 */
function Rope({ width, height, color }: { width: number; height: number; color: string }) {
  // Rope starts at top-left, curves down in the middle (sag), ends at top-right
  const startX = 0;
  const startY = height * 0.15; // Start below top edge
  const endX = width;
  const endY = height * 0.15;
  const sagX = width / 2;
  const sagY = height * 0.45; // Sag point where carabiner hangs

  // Quadratic bezier for smooth catenary-like curve
  const path = `
    M ${startX} ${startY}
    Q ${sagX} ${sagY} ${endX} ${endY}
  `;

  return (
    <Svg
      width={width}
      height={height}
      style={StyleSheet.absoluteFill}
      viewBox={`0 0 ${width} ${height}`}
    >
      <Path
        d={path}
        stroke={color}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/**
 * Full rope + carabiner + wordmark splash composition.
 * Animation sequence:
 * 1. Rope drops down (translateY from -100)
 * 2. Carabiner slides in along rope to sag point
 * 3. Wordmark fades in upwards from below
 */
export function RopeSplash({ animated = true }: RopeSplashProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const shouldAnimate = animated && !reducedMotion;

  // Animation values
  const ropeY = useSharedValue(shouldAnimate ? -100 : 0);
  const carabinerY = useSharedValue(shouldAnimate ? -50 : 0);
  const carabinerOpacity = useSharedValue(shouldAnimate ? 0 : 1);
  const wordmarkY = useSharedValue(shouldAnimate ? 30 : 0);
  const wordmarkOpacity = useSharedValue(shouldAnimate ? 0 : 1);

  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!shouldAnimate || hasAnimated.current) return;
    hasAnimated.current = true;

    // 1. Rope drops down
    ropeY.value = withSpring(0, SPRING_CONFIGS.gentle);

    // 2. Carabiner slides in (delayed after rope starts)
    carabinerOpacity.value = withDelay(150, withTiming(1, { duration: 100 }));
    carabinerY.value = withDelay(
      150,
      withSpring(0, SPRING_CONFIGS.snappy)
    );

    // 3. Wordmark fades in upwards (after rope + carabiner settle)
    wordmarkOpacity.value = withDelay(
      500,
      withTiming(1, { duration: theme.motion.base })
    );
    wordmarkY.value = withDelay(
      500,
      withSpring(0, SPRING_CONFIGS.gentle)
    );
  }, [shouldAnimate, ropeY, carabinerY, carabinerOpacity, wordmarkY, wordmarkOpacity, theme.motion]);

  const ropeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ropeY.value }],
  }));

  const carabinerStyle = useAnimatedStyle(() => ({
    opacity: carabinerOpacity.value,
    transform: [{ translateY: carabinerY.value }],
  }));

  const wordmarkStyle = useAnimatedStyle(() => ({
    opacity: wordmarkOpacity.value,
    transform: [{ translateY: wordmarkY.value }],
  }));

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.bg,
      }}
      accessibilityLabel="Belay - hold the line"
    >
      {/* Rope across top third */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          ropeStyle,
        ]}
      >
        <Rope
          width={400} // Will scale with screen
          height={300}
          color={theme.colors.accentGraphic}
        />
      </Animated.View>

      {/* Carabiner at sag point */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: '20%', // Matches rope sag
            left: '50%',
            marginLeft: -20, // Half carabiner width for centering
          },
          carabinerStyle,
        ]}
      >
        <Carabiner size={40} color={theme.colors.accentGraphic} />
      </Animated.View>

      {/* BELAY wordmark + tagline bottom-right */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            bottom: theme.space.xxl + theme.space.lg,
            right: theme.layout.margin,
            alignItems: 'flex-end',
            gap: theme.space.xxs,
          },
          wordmarkStyle,
        ]}
      >
        <Txt
          variant="display"
          style={{
            fontSize: 48,
            lineHeight: 52,
            letterSpacing: -1.5,
            color: theme.colors.text,
          }}
        >
          BELAY
        </Txt>
        <Micro
          tone="dim"
          style={{
            letterSpacing: 2,
            fontSize: 10,
          }}
        >
          HOLD THE LINE
        </Micro>
      </Animated.View>
    </View>
  );
}
