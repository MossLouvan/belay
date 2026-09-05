// useKeyboardLift — tracks how far the on-screen keyboard intrudes into a
// given view, as an Animated value that rides the keyboard's own animation.
//
// The consumer floats a row (position: absolute, bottom: 0) inside the
// anchored view and translates it up by the lift, instead of wrapping the
// whole screen in KeyboardAvoidingView. That keeps the rest of the layout —
// on the screen tab, the live video stage and the control dock — completely
// still while the keyboard comes and goes; only the floating row moves.
//
// The anchor is measured with measureInWindow at event time, so the math is
// correct whether or not the view reaches the true window bottom (tab bar
// visible vs. immersive fullscreen) — the exact case KeyboardAvoidingView
// gets wrong, because it assumes its layout coordinates ARE window
// coordinates.

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Animated, Dimensions, Easing, Keyboard, Platform, View } from 'react-native';
import type { KeyboardEvent } from 'react-native';
import { useReducedMotion } from './motion';
import { keyboardOverlap, keyboardShown } from './keyboard';

// iOS reports the keyboard animation's duration on the event; Android's
// keyboardDid* events carry 0, so a short honest slide stands in.
const FALLBACK_DURATION_MS = 200;

export interface KeyboardLift {
  /** Points the keyboard currently intrudes into the anchor view (>= 0). */
  readonly lift: Animated.Value;
  /** True while a keyboard frame is on screen. */
  readonly shown: boolean;
}

/**
 * Subscribes to the platform's keyboard frame events. One iOS event covers
 * show, hide AND frame changes (undock, QuickType row); Android only has the
 * did-show/hide pair. Returns the unsubscribe.
 */
function subscribeToKeyboardFrames(onFrame: (event: KeyboardEvent) => void): () => void {
  const subscriptions =
    Platform.OS === 'ios'
      ? [Keyboard.addListener('keyboardWillChangeFrame', onFrame)]
      : [Keyboard.addListener('keyboardDidShow', onFrame), Keyboard.addListener('keyboardDidHide', onFrame)];
  return () => subscriptions.forEach((subscription) => subscription.remove());
}

/**
 * Just the boolean: is a software keyboard on screen right now? For surfaces
 * that only need to show or hide a dismiss affordance (docs/DESIGN.md §11.2 —
 * every keyboard needs a visible exit) without floating anything, so the full
 * measured lift would be waste. Hardware keyboards report no frame and count
 * as hidden, which is right — there is nothing to dismiss.
 */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(
    () =>
      subscribeToKeyboardFrames((event) =>
        setShown(keyboardShown(event?.endCoordinates, Dimensions.get('window').height))
      ),
    []
  );
  return shown;
}

export function useKeyboardLift(anchor: RefObject<View | null>): KeyboardLift {
  const lift = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(false);
  const reduced = useReducedMotion();
  // Read by the (long-lived) listeners without resubscribing on toggle.
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useEffect(() => {
    const settle = (overlap: number, event: KeyboardEvent) => {
      // Guard: never apply negative or unreasonable lifts — these indicate
      // measurement errors that would shift the entire UI. Cap at sensible
      // keyboard height (screen height) to prevent layout corruption.
      const windowHeight = Dimensions.get('window').height;
      const safeOverlap = Math.max(0, Math.min(overlap, windowHeight));
      
      if (reducedRef.current) {
        lift.setValue(safeOverlap);
        return;
      }
      Animated.timing(lift, {
        toValue: safeOverlap,
        duration: event.duration > 0 ? event.duration : FALLBACK_DURATION_MS,
        // Close to UIKit's keyboard curve; translateY-only, so the native
        // driver keeps the row glued to the keyboard even under JS load.
        easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    };

    const onFrame = (event: KeyboardEvent) => {
      const end = event?.endCoordinates;
      const visible = keyboardShown(end, Dimensions.get('window').height);
      setShown(visible);
      if (!visible) {
        settle(0, event);
        return;
      }
      const node = anchor.current;
      if (!node?.measureInWindow) {
        // No anchor to measure (web, or unmounted mid-event): the raw height
        // over-lifts at worst, which still beats hiding under the keyboard.
        settle(end.height, event);
        return;
      }
      node.measureInWindow((_x, y, _w, h) => {
        // Guard against stale measurements: if y is negative or absurdly large,
        // the view has been unmounted or the measurement is stale. Fall back
        // to safe values to prevent layout corruption.
        const windowHeight = Dimensions.get('window').height;
        if (!Number.isFinite(y) || !Number.isFinite(h) || y < 0 || y > windowHeight * 2) {
          settle(0, event);
          return;
        }
        settle(keyboardOverlap(y + h, end.screenY), event);
      });
    };

    return subscribeToKeyboardFrames(onFrame);
  }, [anchor, lift]);

  return { lift, shown };
}
