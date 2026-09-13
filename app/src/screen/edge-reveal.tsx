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
import { PanResponder, Pressable, View } from 'react-native';
import { useLook } from '../design/use-look';
import { useTheme } from '../theme';
import { machineInk } from '../ui/machine-ink';
import { Micro, haptic } from '../ui';
import { isRevealSwipe, REVEAL_EDGE_PX } from './autohide';
import { controlsTabFrame } from './controls-tab';
import { ChevronGlyph, HUD } from './parts';

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

// --- the visible half of the reveal -----------------------------------------

export interface ControlsTabProps {
  /** Fired on a tap: bring the control bar back. */
  readonly onReveal: () => void;
  /** Safe-area insets; the tab hugs the safe left edge under the HUD row. */
  readonly topInset: number;
  readonly leftInset: number;
  readonly testID?: string;
}

/**
 * The landscape controls tab: the SEEN counterpart to the bottom-edge swipe.
 *
 * Sideways the bar auto-hides and the swipe that brings it back is invisible —
 * the founder's verdict was that finding the controls "is not very
 * user-friendly", and he asked for a tap target up in the top-left. This is it:
 * a small tab stuck to the left edge, wearing the word "Controls" beside a
 * chevron, on the same HUD scrim as every other floating control so it reads as
 * chrome over the picture in BOTH appearances (the scrim and its inks are
 * appearance-independent by construction — see the contrast note in parts.tsx —
 * while the corner radius follows the active look).
 *
 * It is a tap, never a drag: mounted only while the bar is away
 * (`controlsTabVisible`), sized and placed by `controlsTabFrame` so it owns one
 * touch target in a corner and leaves the rest of the picture — every pixel a
 * trackpad drag actually starts on — untouched.
 */
export function ControlsTab({ onReveal, topInset, leftInset, testID }: ControlsTabProps) {
  const theme = useTheme();
  const look = useLook();
  const frame = controlsTabFrame({ top: topInset, left: leftInset });

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Show the controls"
      accessibilityHint="Opens the control bar. You can also swipe up from the bottom edge."
      hitSlop={theme.layout.hitSlop}
      onPress={() => {
        haptic('light');
        onReveal();
      }}
      style={({ pressed }) => ({
        position: 'absolute',
        top: frame.top,
        left: frame.left,
        width: frame.width,
        height: frame.height,
        zIndex: 6,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.xxs,
        backgroundColor: HUD.scrim,
        borderWidth: theme.layout.hairline,
        borderColor: HUD.hairline,
        // Rounded on the inboard side only: a tab pulled out of the left edge.
        borderTopRightRadius: look.controlRadius,
        borderBottomRightRadius: look.controlRadius,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <ChevronGlyph direction="up" color={machineInk(theme.scheme).accent} />
      <Micro style={{ color: HUD.ink }}>Controls</Micro>
    </Pressable>
  );
}
