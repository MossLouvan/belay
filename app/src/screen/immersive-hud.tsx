// The overlay along the top edge while immersive (portrait fullscreen or
// landscape): the Connected pill, the recording strip and the sent receipt,
// then whatever notice the route floats over the picture. Recording must
// stay unmissable in fullscreen too — it floats on the HUD scrim over the
// top edge, outliving the dock's auto-hide.
//
// The mascot is no longer drawn here: it is the movable FloatingMascot the
// route floats over everything (floating-mascot.tsx). The top row keeps a
// slot its height for it, and the block reports its measured height so the
// button's clamp and the panel-state guidance (#76) can stay out from under
// the notices.

import React from 'react';
import { View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Txt } from '../ui';
import { MASCOT_BUTTON_SIZE } from './mascot-button';
import { HUD } from './parts';
import { RecordStrip, SentNotice } from './record-parts';
import type { SentInfo } from './record-parts';
import type { RecordingStatus } from './record';

export interface ImmersiveHudProps {
  /** The block's measured height, so the route knows where its bottom edge is. */
  readonly onHeight: (height: number) => void;
  readonly recordingStatus: RecordingStatus;
  readonly onStopRecording: () => void;
  readonly onReviewRecording: () => void;
  readonly sent: SentInfo | null;
  readonly onOpenSent: () => void;
  /** Input errors still matter while immersive; they float under the strip. */
  readonly children: ReactNode;
}

export function ImmersiveHud({
  onHeight,
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
      onLayout={(event: LayoutChangeEvent) => onHeight(event.nativeEvent.layout.height)}
      style={{ pointerEvents: 'box-none', position: 'absolute', top: insets.top + theme.space.xs, left: 0, right: 0, zIndex: 3 }}
    >
      {/* The top row: Connected pill (left); the right is the mascot button's slot. */}
      <View style={{ pointerEvents: 'box-none', flexDirection: 'row', alignItems: 'flex-start', minHeight: MASCOT_BUTTON_SIZE, paddingHorizontal: theme.space.sm, marginBottom: theme.space.xs }}>
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
