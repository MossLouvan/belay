// Selection controls and tappable list rows.
//
// The segmented control is a filled chip track, the same drawing the desktop
// screen's Trackpad · Keyboard · Controller strip uses: a recessed bordered
// rail with the selected option filled — solid accent on Current, the muted
// scorch on Fieldwork. One selection language across the app rather than an
// underline here and a chip there.
//
// `role` decides how the strip is announced. A strip that switches which view
// you are looking at is a tablist; a strip that picks one value of a setting —
// Appearance, quality — is a radiogroup, and a screen reader says so.

import React, { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { haptic } from './haptics';
import { Row } from './layout';
import { Txt } from './text';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Announced as the group's purpose, e.g. "Quality". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** When true, every segment is non-interactive. */
  disabled?: boolean;
  /**
   * How the strip is announced. `tab` switches views (the default, and what
   * every existing caller means); `radio` picks one value of a setting, which
   * is what the Appearance picker is.
   */
  role?: 'tab' | 'radio';
}

/**
 * Visual height of one text tab. Shorter than the 44pt minimum so the strip
 * stays chrome-dense; the shortfall is made up with vertical `hitSlop` so the
 * *effective* target is a full `layout.minTouch`.
 */
const SEGMENT_HEIGHT = 34;

/**
 * Text-segmented control: `UPDATE RATE  1S [2S] 5S` style. The selected option
 * gets the accent label plus the 2pt underline; unselected options sit on the
 * accentDim track so the strip reads as one control, not scattered words.
 *
 * Horizontal slop is intentionally omitted: segments are adjacent, so widening
 * them sideways would make neighbouring targets overlap.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  style,
  testID,
  disabled = false,
  role = 'tab',
}: SegmentedControlProps<T>) {
  const theme = useTheme();
  const look = useLook();
  // Split the shortfall evenly above and below so the effective target is
  // centred on the segment. Clamped at 0 in case the constants ever cross over.
  const slop = Math.max(0, Math.round((theme.layout.minTouch - SEGMENT_HEIGHT) / 2));
  const segmentHitSlop = { top: slop, bottom: slop };
  // Fieldwork's selected chip is the muted scorch with orange ink: a solid
  // orange chip on a near-black page is a flare, not a selection.
  const activeFill = look.segmentSoft ? theme.colors.accentSoft : theme.colors.accent;
  const activeInk = look.segmentSoft ? theme.colors.onAccentSoft : theme.colors.onAccent;

  return (
    <View
      testID={testID}
      accessibilityRole={role === 'radio' ? 'radiogroup' : 'tablist'}
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          flexDirection: 'row',
          padding: 3,
          borderRadius: look.controlRadius + 4,
          backgroundColor: theme.colors.surfaceAlt,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const optionDisabled = disabled || Boolean(option.disabled);
        return (
          <Pressable
            key={option.value}
            accessibilityRole={role === 'radio' ? 'radio' : 'tab'}
            accessibilityLabel={option.label}
            // A radio is announced by `checked`, a tab by `selected`, and
            // react-native-web only emits the attribute whose key is present —
            // passing the other as `undefined` leaves the state off the DOM
            // node entirely, which is how a checked radio reported nothing.
            accessibilityState={
              role === 'radio'
                ? { checked: selected, disabled: optionDisabled }
                : { selected, disabled: optionDisabled }
            }
            // react-native-web renders `accessibilityState.checked` only for
            // the roles IT considers checkable, and a View-backed radio is not
            // one of them — so the attribute never reached the DOM. The `aria-`
            // prop is passed through verbatim on web and ignored on native,
            // where `accessibilityState` above is what VoiceOver reads.
            aria-checked={role === 'radio' ? selected : undefined}
            disabled={optionDisabled}
            hitSlop={segmentHitSlop}
            onPress={() => {
              if (selected || optionDisabled) return;
              haptic('selection');
              onChange(option.value);
            }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: SEGMENT_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.space.xs,
              borderRadius: look.controlRadius + 1,
              backgroundColor: selected ? activeFill : 'transparent',
              opacity: optionDisabled ? 0.4 : pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Txt
              variant="button"
              numberOfLines={1}
              style={{ fontSize: 14 }}
              color={selected ? activeInk : theme.colors.text}
            >
              {option.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface ListItemProps {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  /** Renders the title in the destructive colour. */
  destructive?: boolean;
  /** Renders title/subtitle in the monospace face — handy for file paths. */
  mono?: boolean;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A row in a list. Square, hairline-thinking: no radius, no hover fill —
 * selection is the soft accent band, press is opacity. Rows keep the uniform
 * `layout.rowHeight` so a list scans as a table (docs/DESIGN.md §2.7).
 * Non-interactive when no `onPress` is supplied.
 */
export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  onLongPress,
  selected,
  disabled = false,
  destructive,
  mono,
  accessibilityHint,
  testID,
  style,
}: ListItemProps) {
  const theme = useTheme();
  const interactive = Boolean(onPress || onLongPress);

  const handlePress = useCallback(() => {
    if (disabled || !onPress) return;
    haptic('light');
    onPress();
  }, [disabled, onPress]);

  const rowStyle = {
    minHeight: theme.layout.rowHeight,
    paddingVertical: theme.space.xs,
    backgroundColor: selected ? theme.colors.accentSoft : 'transparent',
    opacity: disabled ? 0.45 : 1,
  } as const;

  const content = (
    <>
      {leading ? <View accessibilityElementsHidden>{leading}</View> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt
          variant={mono ? 'mono' : 'subheading'}
          numberOfLines={1}
          color={destructive ? theme.colors.bad : theme.colors.text}
        >
          {title}
        </Txt>
        {subtitle ? (
          // A selected row paints the translucent accentSoft fill behind this
          // text, and textFaint drops under 4.5:1 once that fill is composited
          // over the host surface. textDim stays above 4.5:1 on both.
          <Txt variant={mono ? 'monoSmall' : 'caption'} tone={selected ? 'dim' : 'faint'} numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
    </>
  );

  if (!interactive) {
    return (
      <View style={style}>
        <Row gap="sm" style={rowStyle}>
          {content}
          {trailing ? <View>{trailing}</View> : null}
        </Row>
      </View>
    );
  }

  // An interactive row with a trailing control is laid out as siblings rather
  // than nesting the control inside the row's Pressable.
  //
  // On web, Pressable renders a <button>, and `trailing` is usually an
  // IconButton — another <button>. Nested buttons are invalid HTML: React DOM
  // logs a validateDOMNesting error, and in development that surfaces as an
  // Expo LogBox toast which sits on top of the page and swallows clicks. That
  // is exactly how the checked-in Playwright failures were produced — the suite
  // could not click "Pair" because a warning about this was covering it.
  //
  // Splitting them also fixes the real interaction bug underneath: tapping the
  // trailing control previously also fired the row's own onPress.
  if (trailing) {
    return (
      <Row gap="sm" style={style}>
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
          accessibilityHint={accessibilityHint}
          accessibilityState={{ disabled, selected }}
          disabled={disabled}
          onPress={handlePress}
          onLongPress={onLongPress}
          style={({ pressed }) => ({ flex: 1, opacity: pressed ? theme.motion.pressOpacity : 1 })}
        >
          <Row gap="sm" style={rowStyle}>{content}</Row>
        </Pressable>
        <View style={{ paddingRight: theme.space.sm }}>{trailing}</View>
      </Row>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={handlePress}
      onLongPress={onLongPress}
      style={({ pressed }) => [{ opacity: pressed ? theme.motion.pressOpacity : 1 }, style]}
    >
      <Row gap="sm" style={rowStyle}>{content}</Row>
    </Pressable>
  );
}
