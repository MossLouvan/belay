// Motion helpers: reduced-motion detection and the shared selection/entry
// animations (Alpine Ledger revamp, REVAMP-SPEC §3.5 "still is premium").
// Motion is small, fast and honest — `easing.standard` for every entrance and
// fade, `easing.exit` for exits only, nothing over `motion.slow`, and press
// feedback is opacity, not scale.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Platform } from 'react-native';
import { easing, motion } from '../theme';

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
      duration,
      // §3.5: `standard` decelerate for every fade — a selection flip is a
      // crossfade in both directions, so both directions take `standard`.
      easing: easing.standard,
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

/** Distance of the screen-entry settle, in pt (REVAMP-SPEC §3.5). */
const ENTRANCE_TRANSLATE_PT = 8;

/**
 * Style returned by {@link useEntrance}; spread it onto an `Animated.View`.
 */
export interface EntranceStyle {
  readonly opacity: Animated.Value;
  readonly transform: readonly [{ readonly translateY: Animated.AnimatedInterpolation<number> }];
}

/**
 * Screen-entry motion (REVAMP-SPEC §3.5 "Screen entry"): the content group
 * fades 0→1 over `motion.base` with an 8pt upward settle, `easing.standard`.
 * One group, one move — no stagger cascade. Runs exactly once, on mount.
 *
 * Reduced motion: fade only — the translate collapses to 0 so nothing moves.
 *
 * Usage: `const entrance = useEntrance();` then
 * `<Animated.View style={[styles.body, entrance]}>…</Animated.View>`.
 */
export function useEntrance(): EntranceStyle {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Mount-only: `progress` is ref-stable, so this effect never re-fires and
    // the entry plays once per screen instance, as the spec's "one move".
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.base,
      easing: easing.standard, // §3.5: standard decelerate for every entrance.
      useNativeDriver: USE_NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [progress]);

  const translateY = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        // Reduced motion keeps the fade but pins the settle at 0pt.
        outputRange: [reduced ? 0 : ENTRANCE_TRANSLATE_PT, 0],
      }),
    [progress, reduced],
  );

  // A fresh frozen style per input change — callers never see mutation.
  return useMemo(
    () =>
      Object.freeze({
        opacity: progress,
        transform: Object.freeze([Object.freeze({ translateY })]) as EntranceStyle['transform'],
      }),
    [progress, translateY],
  );
}
