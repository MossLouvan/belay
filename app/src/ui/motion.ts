// Motion helpers: reduced-motion detection and the shared selection/pulse
// animations. The Ledger system's motion is small, fast and honest — ease-out
// timing only, nothing over 240ms, and press feedback is opacity, not scale.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Platform } from 'react-native';
import { motion } from '../theme';

// The native driver is not meaningfully supported by react-native-web.
const USE_NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * True when the user has asked the OS to reduce motion. Defaults to `false` and
 * degrades to `false` if the platform cannot answer, so animations still work
 * on platforms with no accessibility API rather than being silently disabled.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;

    const apply = (value: boolean): void => {
      if (active) setReduced(Boolean(value));
    };

    try {
      AccessibilityInfo.isReduceMotionEnabled?.()
        .then(apply)
        .catch(() => apply(false));
    } catch {
      apply(false);
    }

    let remove: (() => void) | undefined;
    try {
      const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', apply);
      remove = () => sub?.remove?.();
    } catch {
      remove = undefined;
    }

    return () => {
      active = false;
      remove?.();
    };
  }, []);

  return reduced;
}

export interface PressAnimation {
  readonly scale: Animated.AnimatedInterpolation<number> | Animated.Value;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

const STATIC_SCALE = new Animated.Value(1);
const NOOP = (): void => undefined;
const STATIC_PRESS: PressAnimation = Object.freeze({
  scale: STATIC_SCALE,
  onPressIn: NOOP,
  onPressOut: NOOP,
});

/**
 * @deprecated Scale-transform press feedback is banned (docs/DESIGN.md §10) —
 * use `opacity: pressed ? motion.pressOpacity : 1` in the Pressable's style
 * instead. This shim keeps the handlers wired but the scale pinned at 1, so
 * unmigrated call sites compile and simply stop squishing.
 */
export function usePressScale(_to: number = motion.pressScale): PressAnimation {
  return STATIC_PRESS;
}

/**
 * Drives a 0..1 Animated value whenever `active` flips. Used for tab-bar and
 * segmented-control selection states.
 */
export function useToggleAnimation(active: boolean, duration: number = motion.base): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    const target = active ? 1 : 0;
    if (reduced) {
      value.setValue(target);
      return;
    }
    const animation = Animated.timing(value, {
      toValue: target,
      // Reduced motion halves durations app-wide; a non-reduced flip runs full.
      duration,
      useNativeDriver: USE_NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [active, duration, reduced, value]);

  return value;
}

/**
 * A looping 1 → `low` → 1 opacity for live activity: the pulsing live dot
 * (motion.pulse) and the streaming cursor (motion.blink). Under reduced motion
 * it holds full opacity — a frozen half-faded dot would read as a dead state.
 */
export function usePulse(active: boolean, period: number = motion.pulse, low: number = 0.4): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active || reduced) {
      value.setValue(1);
      return;
    }
    const half = period / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: low, duration: half, useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(value, { toValue: 1, duration: half, useNativeDriver: USE_NATIVE_DRIVER }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      value.setValue(1);
    };
  }, [active, reduced, period, low, value]);

  return value;
}
