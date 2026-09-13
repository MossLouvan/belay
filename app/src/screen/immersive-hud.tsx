// The overlay along the top edge while immersive (portrait fullscreen or
// landscape): the link state, the orientation latch, the recording strip and
// the sent receipt, then whatever notice the route floats over the picture.
// Recording must stay unmissable in fullscreen too — it floats on the HUD
// scrim over the top edge, outliving the dock's auto-hide.
//
// Two things here used to be decoration pretending to be information. The
// status pill was the literal word "Connected", unconditionally, with no
// connection state reaching this component at all — so it went on claiming a
// live link through every drop and reconnect. And the control beside it was
// the beluga mark at 48pt, whose accessibility label offered to "flip" it:
// the animated mascot was retired long ago, so the only thing the tap still
// did was the orientation latch, discoverable by nobody. Both now say what is
// true: the pill speaks the app-wide status vocabulary, and the latch is a
// labelled button whose icon shows which way the next tap goes.

import React from 'react';
import { Pressable, View } from 'react-native';
import type { ReactNode } from 'react';
import { IconDeviceMobile, IconDeviceMobileRotated } from '@tabler/icons-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Txt } from '../ui';
import { describeSurface } from '../ui/connection-view';
import type { ConnectionPhase } from '../ui/connection-view';
import { HUD } from './parts';
import { RecordStrip, SentNotice } from './record-parts';
import type { SentInfo } from './record-parts';
import type { RecordingStatus } from './record';

/** The 44pt touch target the latch keeps without drawing a 44pt disc. */
const LATCH_SIZE = 36;
const LATCH_HIT = Object.freeze({ top: 8, bottom: 8, left: 8, right: 8 });

export interface ImmersiveHudProps {
  /** The app-wide link state, so the pill cannot claim more than is true. */
  readonly linkPhase: ConnectionPhase;
  readonly orientationLabel: string;
  readonly orientationPinned: boolean;
  readonly onToggleOrientation: () => void;
  readonly recordingStatus: RecordingStatus;
  readonly onStopRecording: () => void;
  readonly onReviewRecording: () => void;
  readonly sent: SentInfo | null;
  readonly onOpenSent: () => void;
  /** Input errors still matter while immersive; they float under the strip. */
  readonly children: ReactNode;
}

export function ImmersiveHud({
  linkPhase,
  orientationLabel,
  orientationPinned,
  onToggleOrientation,
  recordingStatus,
  onStopRecording,
  onReviewRecording,
  sent,
  onOpenSent,
  children,
}: ImmersiveHudProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const link = describeSurface(linkPhase);
  // The underline is the one coloured mark on the pill. It reads against the
  // fixed HUD scrim rather than the page, so it comes from the graphic roles
  // (>= 3pt marks), never from a text colour.
  const rule = link.status === 'good' ? theme.colors.good
    : link.status === 'warn' ? theme.colors.warn
      : link.status === 'bad' ? theme.colors.bad
        : theme.colors.accentGraphic;
  const Glyph = orientationPinned ? IconDeviceMobile : IconDeviceMobileRotated;

  return (
    <View
      style={{ pointerEvents: 'box-none', position: 'absolute', top: insets.top + theme.space.xs, left: 0, right: 0, zIndex: 3 }}
    >
      <View style={{ pointerEvents: 'box-none', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: theme.space.sm, marginBottom: theme.space.xs }}>
        <View
          testID="immersive-connection"
          accessibilityRole="text"
          accessibilityLabel={`Connection: ${link.word}`}
          style={{
            paddingHorizontal: theme.space.sm,
            paddingVertical: theme.space.xs,
            borderRadius: theme.radius.xs,
            backgroundColor: HUD.scrim,
            borderBottomWidth: theme.layout.ruleEmphasis,
            borderBottomColor: rule,
          }}
        >
          <Txt variant="label" style={{ color: HUD.ink }}>{link.word}</Txt>
        </View>

        <Pressable
          testID="orientation-latch"
          accessibilityRole="button"
          accessibilityLabel={orientationLabel}
          accessibilityState={{ selected: orientationPinned }}
          onPress={onToggleOrientation}
          hitSlop={LATCH_HIT}
          style={({ pressed }) => ({
            width: LATCH_SIZE,
            height: LATCH_SIZE,
            borderRadius: LATCH_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: HUD.scrim,
            borderWidth: theme.layout.ruleEmphasis,
            borderColor: orientationPinned ? theme.colors.accentGraphic : 'transparent',
            opacity: pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <Glyph size={20} strokeWidth={2} color={orientationPinned ? theme.colors.accentGraphic : HUD.ink} />
        </Pressable>
      </View>
      {/* Recording must stay unmissable in fullscreen too — it floats on
          the HUD scrim over the top edge, outliving the dock's auto-hide. */}
      <View style={{ paddingHorizontal: theme.space.sm, gap: theme.space.xxs }}>
        <RecordStrip status={recordingStatus} onStop={onStopRecording} onReview={onReviewRecording} floating />
        {sent ? <SentNotice info={sent} onOpen={onOpenSent} floating /> : null}
      </View>
      {children}
    </View>
  );
}
