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
 * Retired (Alpine Ledger revamp — founder directive "nothing pulses"). Once a
 * looping opacity for the live dot / streaming cursor; now a no-op that always
 * holds full opacity, so every legacy `pulse` call site renders a steady mark
 * instead of a blink. State is now shape (ring→fill) + colour, and waiting is
 * proven by a ticking clock, never by motion. The signature is kept so callers
 * compile until they're migrated off it; the params are ignored.
 */
export function usePulse(_active?: boolean, _period?: number, _low?: number): Animated.Value {
  return useRef(new Animated.Value(1)).current;
}
