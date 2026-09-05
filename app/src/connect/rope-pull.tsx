// The belay rope over the Tailscale guide — motion that means something.
//
// A belayer takes in rope as the climber ascends, so the rope hanging from
// the top of the screen gets shorter with every step completed, and because
// the step content sits directly below it, shortening the rope visibly hauls
// the next step up into place. Same carabiner as the splash and the
// notifications; same single accent; ease-out timing only (springs are
// retired — docs/DESIGN.md). Purely decorative, so it is hidden from
// accessibility, and reduced motion renders it at rest with no travel.

import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { Carabiner, useReducedMotion } from '../ui';

/** How far the rope hangs at the first step, carabiner included. */
const ROPE_FULL = 120;
/** How much rope is still out at the top of the climb. */
const ROPE_TAKEN_IN = 44;
const CARABINER_SIZE = 32;
/** The carabiner is drawn 1.3× taller than wide (see ui/carabiner). */
const CARABINER_HEIGHT = CARABINER_SIZE * 1.3;
const ROPE_WIDTH = 5;
const ROPE_HIGHLIGHT = ROPE_WIDTH * 0.35;

/** The bezier the rest of the app moves on (theme.easing.standard). */
const EASE_STANDARD = Easing.bezier(0.2, 0, 0, 1);

export interface RopePullProps {
  /**
   * How far up the climb the user is, 0..1 — `guideProgress(step)`. The rope
   * is paid in as this grows.
   */
  readonly progress: number;
}

/**
 * Total height the composition occupies at a given progress. Exposed so a
 * parent that must reserve space can, though normally the animated height is
 * the point: content below rides up as the rope is taken in.
 */
export function ropePullHeight(progress: number): number {
  const rope = ROPE_FULL - (ROPE_FULL - ROPE_TAKEN_IN) * progress;
  return rope + CARABINER_HEIGHT;
}

/**
 * Rope descending from the top edge with the brand carabiner at its end.
 *
 * On mount the rope drops in from above (the sanctioned hero move, same as
 * the splash). Afterwards, `progress` changes animate the rope length — and
 * with it the component's height, which is what "pulls" whatever the parent
 * renders below.
 */
export function RopePull({ progress }: RopePullProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  const p = useSharedValue(progress);
  const dropIn = useSharedValue(reducedMotion ? 1 : 0);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      p.value = progress;
      if (!reducedMotion) {
        dropIn.value = withDelay(
          80,
          withTiming(1, { duration: theme.motion.draw, easing: EASE_STANDARD }),
        );
      } else {
        dropIn.value = 1;
      }
      return;
    }
    if (reducedMotion) {
      p.value = progress;
      return;
    }
    p.value = withTiming(progress, { duration: theme.motion.draw, easing: EASE_STANDARD });
  }, [progress, reducedMotion, p, dropIn, theme.motion.draw]);

  const containerStyle = useAnimatedStyle(() => ({
    height: interpolate(p.value, [0, 1], [ROPE_FULL, ROPE_TAKEN_IN]) + CARABINER_HEIGHT,
  }));

  const columnStyle = useAnimatedStyle(() => ({
    opacity: dropIn.value,
    transform: [
      { translateY: interpolate(dropIn.value, [0, 1], [-(ROPE_FULL + CARABINER_HEIGHT), 0]) },
    ],
  }));

  const ropeStyle = useAnimatedStyle(() => ({
    height: interpolate(p.value, [0, 1], [ROPE_FULL, ROPE_TAKEN_IN]),
  }));

  return (
    <Animated.View
      style={[{ alignItems: 'center', overflow: 'visible' }, containerStyle]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <Animated.View style={[{ alignItems: 'center' }, columnStyle]}>
        {/* The rope — realistic climbing rope with twisted strands and depth */}
        <View style={{ position: 'relative', alignItems: 'center' }}>
          {/* Shadow for depth */}
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: 1,
                top: 0,
                width: ROPE_WIDTH,
                borderRadius: ROPE_WIDTH / 2,
                backgroundColor: 'rgba(0, 0, 0, 0.15)',
              },
              ropeStyle,
            ]}
          />
          {/* Main rope body */}
          <Animated.View
            style={[
              {
                width: ROPE_WIDTH,
                borderRadius: ROPE_WIDTH / 2,
                backgroundColor: theme.colors.accentGraphic,
              },
              ropeStyle,
            ]}
          />
          {/* Left highlight strand (creates twisted appearance) */}
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: ROPE_WIDTH * 0.15,
                top: 0,
                width: ROPE_HIGHLIGHT,
                borderRadius: ROPE_HIGHLIGHT / 2,
                backgroundColor: 'rgba(255, 255, 255, 0.35)',
              },
              ropeStyle,
            ]}
          />
          {/* Right subtle strand */}
          <Animated.View
            style={[
              {
                position: 'absolute',
                right: ROPE_WIDTH * 0.2,
                top: 0,
                width: ROPE_HIGHLIGHT * 0.7,
                borderRadius: ROPE_HIGHLIGHT / 2,
                backgroundColor: 'rgba(255, 255, 255, 0.15)',
              },
              ropeStyle,
            ]}
          />
        </View>
        {/* Carabiner clipped to the rope's end, gate up. */}
        <View style={{ marginTop: -4 }}>
          <Carabiner size={CARABINER_SIZE} color={theme.colors.accentGraphic} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}
