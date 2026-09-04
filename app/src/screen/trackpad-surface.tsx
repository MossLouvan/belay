// The deadspace trackpad: the black gap between the letterboxed picture and
// the control bar, made a first-class input surface. It fills the whole
// machine panel BEHIND the stage — the stage, rendered after it, wins every
// touch on the picture, so only the gaps reach this view — and carries the
// viewport's `padHandlers`, which pin the shared gesture vocabulary to
// trackpad (relative) mode: drag nudges the host cursor, tap clicks at it,
// two-finger tap right-clicks, two fingers scroll, three fingers swipe.
//
// Owning these touches is also the fix for the swipe-leak bug: a gesture that
// used to fall through the gap to an ancestor pager (and switch device) is
// now claimed here and refused termination.

import React from 'react';
import { Text, View } from 'react-native';
import type { GestureResponderHandlers } from 'react-native';
import { font } from '../theme';
import { FILL } from './parts';
import { padGapBelow, showsPadHint } from './trackpad';

/** Quiet fixed ink for the hint: the machine panel is true-dark in both
 *  themes, exactly like the HUD chrome beside it. */
const HINT_INK = 'rgba(243, 246, 252, 0.32)';

const HINT_DOTS = [0, 1, 2] as const;

export interface TrackpadSurfaceProps {
  /** The viewport's `padHandlers` — the always-trackpad responder. */
  readonly handlers: GestureResponderHandlers;
  /** Live height of the machine panel, px. */
  readonly boxH: number;
  /** Live height of the letterboxed stage, px. */
  readonly stageH: number;
  /** Immersive layouts center the stage, so the hint stands down. */
  readonly immersive: boolean;
  readonly testID?: string;
}

/**
 * The pad itself plus, when the portrait gap is tall enough to be worth
 * advertising, a centered micro-hint — three quiet dots over the word
 * TRACKPAD, low-contrast on the black so a first-timer learns the surface
 * exists without the stream ever having to compete with it.
 */
export function TrackpadSurface({ handlers, boxH, stageH, immersive, testID }: TrackpadSurfaceProps) {
  const hint = showsPadHint(padGapBelow(boxH, stageH), immersive);
  return (
    <View
      testID={testID}
      accessibilityLabel="Trackpad. Drag to move the mouse pointer, tap to click, two-finger tap to right-click, two fingers to scroll."
      {...handlers}
      style={FILL}
    >
      {hint ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: stageH,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 5 }}>
            {HINT_DOTS.map((i) => (
              <View key={i} style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: HINT_INK }} />
            ))}
          </View>
          <Text allowFontScaling={false} style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 2, color: HINT_INK }}>
            TRACKPAD
          </Text>
        </View>
      ) : null}
    </View>
  );
}
