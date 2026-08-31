// TrackLabel — the tappable text primitive under the track rule
// (docs/DESIGN.md §11.1).
//
// Any interactive text that is not a filled or hairline-outlined button
// renders through this: an 11pt tracked mono label over the 2pt underline
// track — accentGraphic when selected/active, accentDim at rest. The track is
// the same selection language the SegmentedControl already draws, so a tracked
// word anywhere in the app reads as "a control, sibling of the tabs", and a
// bare label stays honestly inert. Callers with hostile backgrounds (the
// fullscreen HUD scrim) override the ink set rather than reinventing the mark.

import React, { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import type { Insets, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';
import type { HapticTone } from './haptics';
import { trackInks } from './track';
import type { TrackInkSet } from './track';
import { Txt } from './text';

export interface TrackLabelProps {
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  /** Selected/active: accent label, lit track. */
  active?: boolean;
  disabled?: boolean;
  /** Overrides any of the four inks — e.g. HUD-tuned colours in fullscreen. */
  inks?: Partial<TrackInkSet>;
  /** Overrides the resolved label ink (e.g. ink-not-accent active sort). */
  labelColor?: string;
  /** Overrides the resolved track ink (e.g. COPY's ✓/✗ status flash). */
  trackColor?: string;
  /** Text alignment inside the touch target. Defaults to left. */
  align?: TextStyle['textAlign'];
  /** Renders as one option of a radio-style group (role `tab`, not button). */
  radio?: boolean;
  /** Haptic fired on press. `null` disables it. */
  hapticTone?: HapticTone | null;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  hitSlop?: Insets;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function TrackLabel({
  label,
  onPress,
  onLongPress,
  active = false,
  disabled = false,
  inks,
  labelColor,
  trackColor,
  align,
  radio = false,
  hapticTone = 'light',
  accessibilityLabel,
  accessibilityHint,
  hitSlop,
  testID,
  style,
}: TrackLabelProps) {
  const theme = useTheme();
  const resolved = trackInks(
    { active, disabled },
    {
      restLabel: inks?.restLabel ?? theme.colors.textDim,
      activeLabel: inks?.activeLabel ?? theme.colors.accent,
      restTrack: inks?.restTrack ?? theme.colors.accentDim,
      activeTrack: inks?.activeTrack ?? theme.colors.accentGraphic,
    }
  );

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (hapticTone) haptic(hapticTone);
    onPress();
  }, [disabled, hapticTone, onPress]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole={radio ? 'tab' : 'button'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={handlePress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        {
          minHeight: theme.layout.minTouch,
          justifyContent: 'center',
          opacity: pressed && !disabled ? theme.motion.pressOpacity : resolved.opacity,
        },
        style,
      ]}
    >
      <Txt variant="label" numberOfLines={1} color={labelColor ?? resolved.label} align={align}>
        {label}
      </Txt>
      {/* The track: decorative to a screen reader (state is announced), but
          THE affordance to a sighted one — never render this under inert text. */}
      <View
        accessibilityElementsHidden
        style={{
          alignSelf: 'stretch',
          height: theme.layout.ruleEmphasis,
          marginTop: theme.space.xxs,
          backgroundColor: trackColor ?? resolved.track,
        }}
      />
    </Pressable>
  );
}
