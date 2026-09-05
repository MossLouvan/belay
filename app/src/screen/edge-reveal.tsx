// The bottom-edge reveal for the auto-hidden immersive control bar.
//
// A thin, invisible strip pinned to the very bottom of the screen, mounted
// ONLY while the bar is hidden. It claims a touch exclusively once the finger
// has committed upward (`isRevealSwipe` in autohide.ts) — a tap, a rest or a
// sideways drag is refused — so it can never be mistaken for remote input,
// and remote input on the desktop can never accidentally reveal the bar.
// The doctrine stands: stage touches are remote input; the ONLY touch that
// reveals the controls starts on this edge, off the desktop's useful surface.

import React, { useMemo, useRef } from 'react';
import { PanResponder, View } from 'react-native';
import { haptic } from '../ui';
import { isRevealSwipe, REVEAL_EDGE_PX } from './autohide';

export interface EdgeRevealStripProps {
  /** Fired once, when an upward swipe commits. */
  readonly onReveal: () => void;
  /** Safe-area bottom inset; the strip covers at least the home-indicator band. */
  readonly bottomInset: number;
  /** When true, the strip is disabled and won't respond to touches. */
  readonly disabled?: boolean;
  readonly testID?: string;
}

export function EdgeRevealStrip({ onReveal, bottomInset, disabled = false, testID }: EdgeRevealStripProps) {
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;

  const handlers = useMemo(
    () =>
      PanResponder.create({
        // Never on touch-down: claiming only once the move commits upward is
        // what keeps a stray tap on the edge from doing anything at all.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, state) => isRevealSwipe(state.dx, state.dy),
        onPanResponderGrant: () => {
          haptic('light');
          onRevealRef.current();
        },
        // The reveal has already fired; the system may take the rest.
        onPanResponderTerminationRequest: () => true,
      }).panHandlers,
    []
  );

  return (
    <View
      testID={testID}
      accessibilityLabel="Show the controls"
      accessibilityHint="Swipe up from the bottom edge"
      {...handlers}
      pointerEvents={disabled ? 'none' : 'box-only'}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: Math.max(REVEAL_EDGE_PX, bottomInset),
      }}
    />
  );
}
