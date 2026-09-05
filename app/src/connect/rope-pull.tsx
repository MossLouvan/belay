// The belay rope over the Tailscale guide — motion that means something.
//
// A belayer takes in rope as the climber ascends, so the rope hanging from
// the top of the screen gets shorter with every step completed, and because
// the step content sits directly below it, shortening the rope visibly hauls
// the next step up into place. The carabiner shows load/tension: not hanging
// ornamentally but clipped and bearing weight as the rope is taken in. Same
// carabiner as the splash and notifications; same single accent; ease-out
// timing. Purely decorative, so it is hidden from accessibility, and reduced
// motion renders it at rest with no travel.

import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
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
const ROPE_WIDTH = 3;

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
 * renders below. The carabiner shows subtle physics: a slight bounce when
 * the rope is taken in (load shift) to reinforce that it's bearing weight.
 */
export function RopePull({ progress }: RopePullProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  const p = useSharedValue(progress);
  const dropIn = useSharedValue(reducedMotion ? 1 : 0);
  const carabinerBounce = useSharedValue(0); // Subtle bounce on rope changes
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
    // Animate rope taking in with subtle carabiner load shift
    p.value = withTiming(progress, { duration: theme.motion.draw, easing: EASE_STANDARD });
    // Subtle bounce shows the load shifting as rope is taken in
    carabinerBounce.value = withSequence(
      withTiming(-2, { duration: theme.motion.fast * 0.6, easing: EASE_STANDARD }),
      withTiming(1, { duration: theme.motion.fast * 0.4, easing: EASE_STANDARD }),
      withTiming(0, { duration: theme.motion.base * 0.6, easing: EASE_STANDARD })
    );
  }, [progress, reducedMotion, p, dropIn, carabinerBounce, theme.motion.draw, theme.motion.fast, theme.motion.base]);

  // Cancel any pending animations on unmount
  useEffect(() => {
    return () => {
      mounted.current = false;
      // Cancel animations by setting values directly (no animation)
      p.value = progress;
      dropIn.value = 1;
      carabinerBounce.value = 0;
    };
  }, [p, dropIn, carabinerBounce, progress]);

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

  const carabinerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: carabinerBounce.value }],
  }));

  return (
    <Animated.View
      style={[{ alignItems: 'center' }, containerStyle]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <Animated.View style={[{ alignItems: 'center' }, columnStyle]}>
        {/* The rope — a plain taut line under tension; the sag lives on the splash. */}
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
        {/* Carabiner clipped to the rope's end, gate up, showing load with subtle physics. */}
        <Animated.View style={[{ marginTop: -4 }, carabinerStyle]}>
          <Carabiner size={CARABINER_SIZE} color={theme.colors.accentGraphic} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
