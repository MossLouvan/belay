// The deadspace trackpad: the gap between the letterboxed picture and the
// control bar, made a first-class input surface. It fills the whole machine
// panel BEHIND the stage — the stage, rendered after it, wins every touch on
// the picture, so only the gaps reach this view — and carries the viewport's
// `padHandlers`, which pin the shared gesture vocabulary to trackpad
// (relative) mode: drag nudges the host cursor, tap clicks at it, two-finger
// tap right-clicks, two fingers scroll, three fingers swipe.
//
// Owning these touches is also the fix for the swipe-leak bug: a gesture that
// used to fall through the gap to an ancestor pager (and switch device) is now
// claimed here and refused termination. That refusal only binds JS responders:
// the navigator's native swipe-back cancels touches from outside the responder
// system, so it is switched off on the desktop route (app/app/_layout.tsx).
//
// The two appearances advertise the surface differently and the mockups are
// explicit about it: Current writes "Swipe to move cursor" across the empty
// well, Fieldwork says nothing and instead gives the pad a faint dot texture
// you can see is a different material. `look.padHint` / `look.padTexture`.

import React from 'react';
import { View } from 'react-native';
import type { GestureResponderHandlers } from 'react-native';
import { IconArrowsHorizontal, IconHandFinger } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Txt } from '../ui';
import { FILL } from './parts';
import { padGapBelow, showsPadHint } from './trackpad';
import { PadTexture } from './pad-dots';

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

export function TrackpadSurface({ handlers, boxH, stageH, immersive, testID }: TrackpadSurfaceProps) {
  const theme = useTheme();
  const look = useLook();
  const roomy = showsPadHint(padGapBelow(boxH, stageH), immersive);

  return (
    <View
      testID={testID}
      accessibilityLabel="Trackpad. Drag to move the mouse pointer, tap to click, two-finger tap to right-click, two fingers to scroll."
      {...handlers}
      style={immersive ? FILL : {
        position: 'absolute',
        top: stageH + 72,
        bottom: 8,
        left: 0,
        right: 0,
        borderRadius: look.cardRadius,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: look.cardBorder ? 0 : theme.layout.hairline,
        borderColor: theme.colors.border,
        overflow: 'hidden',
      }}
    >
      {!immersive && look.padTexture ? <PadTexture /> : null}
      {roomy && look.padHint ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: immersive ? stageH : 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <IconArrowsHorizontal size={40} strokeWidth={1.4} color={theme.colors.textFaint} />
          <IconHandFinger size={30} strokeWidth={1.4} color={theme.colors.textFaint} style={{ marginTop: -16 }} />
          <Txt variant="caption" tone="faint">Swipe to move cursor</Txt>
        </View>
      ) : null}
    </View>
  );
}
