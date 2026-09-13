// The dock's pointer-mode switch — a real, boxed segmented control.
//
// The founder's on-device verdict on the old treatment was blunt: three
// tracked words in a row of many read as caption text, and he "couldn't
// really change from touch mode to pad mode". So the mode trio gets the one
// loud treatment in the dock: a bordered strip of full-height segments where
// the ACTIVE mode is a solid accent fill — a filled button, not an
// underline — and the inactive ones are full-ink words with the whole
// segment tappable. Every segment clears the 44pt HIG target on both axes.
//
// The options themselves (labels, VoiceOver words, teaching hints) are data
// in ./dock-modes.ts; this file only draws them.
//
// Two ink sets, for two different grounds:
//
//   * FLOATING, over the fullscreen HUD scrim: the dark palette's inks and the
//     SOLID accent, always. Those are tuned to read over an arbitrary video
//     frame, which is why they ignore the appearance — `look.segmentSoft` is a
//     rule about a selected chip on the PAGE, and a muted scorch fill
//     disappears against a bright desktop.
//   * On the page (the More controls sheet): the same selection treatment as
//     the portrait mode strip (src/screen/mode-strip.tsx), so one app does not
//     answer "how is a selected segment drawn?" two ways on two surfaces.
//     Current fills solid accent; Fieldwork uses the muted scorch with orange
//     ink.

import type { ScreenMode } from './dock-modes';
import React from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { machineInk } from '../ui/machine-ink';
import { useLook } from '../design/use-look';
import { Txt, haptic } from '../ui';
import { HUD } from './parts';
import { POINTER_MODE_OPTIONS } from './dock-modes';

/** The ink set a boxed control needs, resolved once per render. */
interface BoxedInks {
  readonly border: string;
  readonly restLabel: string;
  readonly fill: string;
  readonly onFill: string;
}

function useBoxedInks(floating: boolean): BoxedInks {
  const theme = useTheme();
  const look = useLook();
  if (floating) {
    const dark = machineInk(theme.scheme);
    return {
      border: HUD.hairline,
      restLabel: HUD.ink,
      fill: dark.accent,
      onFill: dark.onAccent,
    };
  }
  return {
    border: theme.colors.borderStrong,
    restLabel: theme.colors.text,
    fill: look.segmentSoft ? theme.colors.accentSoft : theme.colors.accent,
    onFill: look.segmentSoft ? theme.colors.onAccentSoft : theme.colors.onAccent,
  };
}

export interface ModeSwitchProps {
  mode: ScreenMode;
  onModeChange: (mode: ScreenMode) => void;
  /** Floating over the stream (fullscreen): chrome uses the HUD scrim inks. */
  floating?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Touch / Pad / Scroll as one bordered strip of equal segments, the active
 * one solid-filled. Radio semantics: role `tab` per segment inside a
 * `tablist`, exactly what the old trio announced, so nothing regresses for
 * a screen reader while everything improves for a sighted thumb.
 */
export function ModeSwitch({ mode, onModeChange, floating = false, testID, style }: ModeSwitchProps) {
  const theme = useTheme();
  const inks = useBoxedInks(floating);

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      accessibilityLabel="Screen mode"
      style={[
        {
          flexDirection: 'row',
          minHeight: theme.layout.minTouch,
          minWidth: POINTER_MODE_OPTIONS.length * (theme.layout.minTouch + theme.space.xs),
          borderWidth: theme.layout.hairline,
          borderColor: inks.border,
          borderRadius: theme.radius.xs,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {POINTER_MODE_OPTIONS.map((option, index) => {
        const active = option.id === mode;
        return (
          <Pressable
            key={option.id}
            testID={testID ? `${testID}-${option.id}` : undefined}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel}
            accessibilityHint={option.hint}
            accessibilityState={{ selected: active }}
            onPress={() => {
              haptic('selection');
              onModeChange(option.id);
            }}
            style={{
              flex: 1,
              minHeight: theme.layout.minTouch,
              minWidth: theme.layout.minTouch,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.space.xxs,
              backgroundColor: active ? inks.fill : 'transparent',
              borderLeftWidth: index > 0 ? theme.layout.hairline : 0,
              borderLeftColor: inks.border,
            }}
          >
            <Txt variant="label" numberOfLines={1} color={active ? inks.onFill : inks.restLabel}>
              {option.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
