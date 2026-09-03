// TrackLabel — the tappable text primitive under the track rule
// (docs/DESIGN.md §11.1, as amended by docs/REVAMP-SPEC.md §5.3).
//
// Any interactive text that is not a filled or hairline-outlined button
// renders through this: an 11pt tracked mono label over the 2pt underline
// track. The track is the rope (REVAMP-SPEC §1): granite `trackRest` when
// slack, `accentGraphic` only when loaded — selected, armed, or under the
// finger. "Orange means engaged" (REVAMP-SPEC §7 rule 4); the mark, not the
// colour, is what says "control" — so a dock of resting keys reads as
// machined grey hardware with exactly the engaged ones glowing.
//
// Press feedback is the ignition ("the rope takes load", REVAMP-SPEC §3.5):
// on press-in the track snaps to `accentGraphic` and the label to full ink,
// instantly; on release it relaxes back over `motion.fast`. No opacity dim,
// no scale — the key feels mechanical, and holds still otherwise.
//
// The track is the same selection language the SegmentedControl already
// draws, so a tracked word anywhere in the app reads as "a control, sibling
// of the tabs", and a bare label stays honestly inert. Callers with hostile
// backgrounds (the fullscreen HUD scrim) override the ink set rather than
// reinventing the mark.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import type { Insets, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { easing, useTheme } from '../theme';
import { haptic } from './haptics';
import type { HapticTone } from './haptics';
import { useReducedMotion } from './motion';
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
  /** Overrides any of the inks — e.g. HUD-tuned colours in fullscreen. */
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
  const reducedMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);

  // The full ink set for this label. Caller overrides (the HUD dock's
  // scrim-tuned inks, bespoke rest/active colours) always win over the theme
  // defaults — a new object every render, nothing mutated.
  const inkSet: TrackInkSet = useMemo(
    () => ({
      restLabel: inks?.restLabel ?? theme.colors.textDim,
      activeLabel: inks?.activeLabel ?? theme.colors.accent,
      // REVAMP-SPEC §5.3: the resting rope is granite, not orange.
      restTrack: inks?.restTrack ?? theme.colors.trackRest,
      activeTrack: inks?.activeTrack ?? theme.colors.accentGraphic,
      // REVAMP-SPEC §3.5: under load the label goes to full ink.
      pressLabel: inks?.pressLabel ?? theme.colors.text,
    }),
    [inks, theme]
  );

  const resolved = trackInks({ active, disabled, pressed }, inkSet);

  // Ignition drive: 0 = slack, 1 = loaded. Press-in SNAPS to 1 (no ramp — the
  // rope takes load instantly, REVAMP-SPEC §3.5); release relaxes back over
  // `motion.fast` (halved under reduced motion — it is already a pure fade).
  const load = useRef(new Animated.Value(0)).current;

  const handlePressIn = useCallback(() => {
    setPressed(true);
    load.stopAnimation();
    load.setValue(1);
  }, [load]);

  const handlePressOut = useCallback(() => {
    setPressed(false);
    Animated.timing(load, {
      toValue: 0,
      duration: reducedMotion ? theme.motion.fast / 2 : theme.motion.fast,
      easing: easing.standard,
      // Colour interpolation cannot ride the native driver.
      useNativeDriver: false,
    }).start();
  }, [load, reducedMotion, theme.motion.fast]);

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (hapticTone) haptic(hapticTone);
    onPress();
  }, [disabled, hapticTone, onPress]);

  // What the 2pt rope paints. Explicit `trackColor` (status flashes) wins,
  // then a lit state (active/armed keys hold steady orange — no animation),
  // then the ignition interpolation between slack granite and loaded orange.
  const trackBackground: string | Animated.AnimatedInterpolation<string> =
    trackColor ??
    (active
      ? resolved.track
      : load.interpolate({
          inputRange: [0, 1],
          outputRange: [inkSet.restTrack, inkSet.activeTrack],
        }));

  return (
    <Pressable
      testID={testID}
      accessibilityRole={radio ? 'tab' : 'button'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      style={[
        {
          minHeight: theme.layout.minTouch,
          justifyContent: 'center',
          // Press feedback is the ignition, not a dim (REVAMP-SPEC §3.5);
          // only the disabled state changes the control's opacity.
          opacity: resolved.opacity,
        },
        style,
      ]}
    >
      <Txt variant="label" numberOfLines={1} color={labelColor ?? resolved.label} align={align}>
        {label}
      </Txt>
      {/* The rope: decorative to a screen reader (state is announced), but
          THE affordance to a sighted one — never render this under inert
          text. Slack granite at rest; orange only under load (§5.3). */}
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility={Platform.OS === 'android' ? 'no' : undefined}
        style={{
          alignSelf: 'stretch',
          height: theme.layout.ruleEmphasis,
          marginTop: theme.space.xxs,
          backgroundColor: trackBackground,
        }}
      />
    </Pressable>
  );
}
