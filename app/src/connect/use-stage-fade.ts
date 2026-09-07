// The connect screen's stage crossfade: fade out, swap the stage, fade in.
// Reduced motion is an instant cut. Generic over the stage vocabulary so the
// hook has no opinion about what the stages are.

import { useCallback, useRef } from 'react';
import { Animated } from 'react-native';
import { useTheme } from '../theme';
import { useReducedMotion } from '../ui';

export interface StageFade<S> {
  /** Drive the stage container's opacity with this. */
  readonly fadeAnim: Animated.Value;
  /** Move to `next` behind a crossfade (or instantly, under reduced motion). */
  readonly transitionToStage: (next: S) => void;
}

export function useStageFade<S>(setStage: (next: S) => void): StageFade<S> {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const transitionToStage = useCallback(
    (nextStage: S) => {
      if (reducedMotion) {
        setStage(nextStage);
        return;
      }

      // Fade out
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: theme.motion.fast,
        useNativeDriver: true,
      }).start(() => {
        setStage(nextStage);
        // Fade in
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: theme.motion.base,
          useNativeDriver: true,
        }).start();
      });
    },
    [fadeAnim, reducedMotion, setStage, theme.motion],
  );

  return { fadeAnim, transitionToStage };
}
