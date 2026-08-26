// Motion helpers: reduced-motion detection and the shared press animation.

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

/**
 * A spring-backed press-down scale. Returns a static value when reduced motion
 * is on, so the handlers stay wired but nothing actually moves.
 */
export function usePressScale(to: number = motion.pressScale): PressAnimation {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(1)).current;

  const animate = useCallback(
    (target: number) => {
      if (reduced) return;
      Animated.spring(value, {
        toValue: target,
        useNativeDriver: USE_NATIVE_DRIVER,
        ...motion.spring,
      }).start();
    },
    [reduced, value]
  );

  const onPressIn = useCallback(() => animate(to), [animate, to]);
  const onPressOut = useCallback(() => animate(1), [animate]);

  return useMemo(() => ({ scale: value, onPressIn, onPressOut }), [value, onPressIn, onPressOut]);
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
      duration,
      useNativeDriver: USE_NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [active, duration, reduced, value]);

  return value;
}
