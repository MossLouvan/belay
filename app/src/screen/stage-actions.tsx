// The pair of pills under the picture: Audio and Fullscreen.
//
// Both mockups draw them identically — two equal-width bordered pills, an
// accent glyph, a dark label — so there is no per-appearance branch here, only
// the shared card/control tokens. Kept out of stage-view.tsx because that file
// already owns the letterboxing maths and the no-picture guidance surface.

import React from 'react';
import { Pressable, View } from 'react-native';
import { IconMaximize, IconVolume, IconVolumeOff } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Txt } from '../ui';
import { haptic } from '../ui/haptics';

interface PillProps {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon: React.ReactNode;
  readonly onPress: () => void;
  readonly testID: string;
}

function Pill({ label, accessibilityLabel, icon, onPress, testID }: PillProps) {
  const theme = useTheme();
  const look = useLook();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => { haptic('light'); onPress(); }}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minHeight: theme.layout.minTouch,
        borderRadius: look.controlRadius + 2,
        backgroundColor: theme.colors.surface,
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.border,
        opacity: pressed ? theme.motion.pressOpacity : 1,
      })}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{icon}</View>
      <Txt variant="button" numberOfLines={1}>{label}</Txt>
    </Pressable>
  );
}

export interface StageActionsProps {
  readonly audioOn: boolean;
  readonly audioLabel: string;
  readonly onToggleAudio: () => void;
  readonly onToggleFullscreen: () => void;
}

export function StageActions({ audioOn, audioLabel, onToggleAudio, onToggleFullscreen }: StageActionsProps) {
  const theme = useTheme();
  // The audio glyph is the accent only while sound is actually coming through:
  // an orange speaker on a muted stream is the control lying about its state.
  const audioTint = audioOn ? theme.colors.accent : theme.colors.textDim;
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <Pill
        testID="quick-audio"
        label={audioLabel}
        icon={audioOn
          ? <IconVolume size={20} strokeWidth={2} color={audioTint} />
          : <IconVolumeOff size={20} strokeWidth={2} color={audioTint} />}
        onPress={onToggleAudio}
      />
      <Pill
        testID="stage-fullscreen"
        label="Fullscreen"
        accessibilityLabel="Enter full screen"
        icon={<IconMaximize size={20} strokeWidth={2} color={theme.colors.accent} />}
        onPress={onToggleFullscreen}
      />
    </View>
  );
}
