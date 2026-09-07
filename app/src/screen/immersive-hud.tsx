// The overlay along the top edge while immersive (portrait fullscreen or
// landscape): the Connected pill, the mascot, the recording strip and the
// sent receipt, then whatever notice the route floats over the picture.
// Recording must stay unmissable in fullscreen too — it floats on the HUD
// scrim over the top edge, outliving the dock's auto-hide.

import React from 'react';
import { View } from 'react-native';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { BelugaAvatar, Txt } from '../ui';
import { HUD } from './parts';
import { RecordStrip, SentNotice } from './record-parts';
import type { SentInfo } from './record-parts';
import type { RecordingStatus } from './record';

export interface ImmersiveHudProps {
  readonly mascotLabel: string;
  readonly onMascotPress: () => void;
  readonly recordingStatus: RecordingStatus;
  readonly onStopRecording: () => void;
  readonly onReviewRecording: () => void;
  readonly sent: SentInfo | null;
  readonly onOpenSent: () => void;
  /** Input errors still matter while immersive; they float under the strip. */
  readonly children: ReactNode;
}

export function ImmersiveHud({
  mascotLabel,
  onMascotPress,
  recordingStatus,
  onStopRecording,
  onReviewRecording,
  sent,
  onOpenSent,
  children,
}: ImmersiveHudProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{ pointerEvents: 'box-none', position: 'absolute', top: insets.top + theme.space.xs, left: 0, right: 0, zIndex: 3 }}
    >
      {/* Landscape HUD: Connected pill (top-left) and beluga avatar (top-right) */}
      <View style={{ pointerEvents: 'box-none', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: theme.space.sm, marginBottom: theme.space.xs }}>
        {/* Connected status pill */}
        <View
          style={{
            paddingHorizontal: theme.space.sm,
            paddingVertical: theme.space.xs,
            borderRadius: theme.radius.xs,
            backgroundColor: HUD.scrim,
            borderBottomWidth: 2,
            borderBottomColor: theme.colors.accentGraphic,
          }}
        >
          <Txt variant="label" style={{ color: HUD.ink }}>Connected</Txt>
        </View>
        {/* Beluga avatar: the flip plus the orientation latch — from
            landscape, tapping the mascot IS "take me back upright".
            Screen options moved to the dock's Menu key. */}
        <BelugaAvatar
          testID="stream-beluga-avatar"
          size={48}
          backgroundColor={HUD.scrim}
          accessibilityLabel={mascotLabel}
          onPress={onMascotPress}
        />
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
