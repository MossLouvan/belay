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
// in ./dock-modes.ts; this file only draws them. `BoxedToggle` is the same
// visual language for a lone on/off key (KEYS), so the dock's primary row
// speaks one dialect: box = big control, fill = engaged.
//
// Floating (the fullscreen HUD scrim) swaps to the dark palette's inks the
// same way DockKey does — the light theme's dim text and paper borders are
// tuned for paper and fail on the near-black scrim.

import React from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { getTheme, useTheme } from '../theme';
import { Txt, haptic } from '../ui';
import { HUD } from './parts';
import { POINTER_MODE_OPTIONS } from './dock-modes';
import type { PointerMode } from './viewport';

/** The ink set a boxed control needs, resolved once per render. */
interface BoxedInks {
  readonly border: string;
  readonly restLabel: string;
  readonly fill: string;
  readonly onFill: string;
}

function useBoxedInks(floating: boolean): BoxedInks {
  const theme = useTheme();
  if (floating) {
    const dark = getTheme('dark').colors;
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
    fill: theme.colors.accent,
    onFill: theme.colors.onAccent,
  };
}

export interface ModeSwitchProps {
  mode: PointerMode;
  onModeChange: (mode: PointerMode) => void;
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
      accessibilityLabel="Pointer mode"
      style={[
        {
          flexDirection: 'row',
          minHeight: theme.layout.minTouch,
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

export interface BoxedToggleProps {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  floating?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A lone boxed toggle in the switch's visual language — the KEYS key rides
 * next to the mode strip at the same height, filled while its bar is up.
 */
export function BoxedToggle({
  label,
  active,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  floating = false,
  testID,
  style,
}: BoxedToggleProps) {
  const theme = useTheme();
  const inks = useBoxedInks(floating);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={[
        {
          minHeight: theme.layout.minTouch,
          minWidth: theme.layout.minTouch,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: theme.space.xs,
          borderWidth: theme.layout.hairline,
          borderColor: inks.border,
          borderRadius: theme.radius.xs,
          backgroundColor: active ? inks.fill : 'transparent',
        },
        style,
      ]}
    >
      <Txt variant="label" numberOfLines={1} color={active ? inks.onFill : inks.restLabel}>
        {label}
      </Txt>
    </Pressable>
  );
}
