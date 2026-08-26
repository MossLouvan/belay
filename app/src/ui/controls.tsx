// Selection controls and tappable list rows.

import React, { useCallback } from 'react';
import { Pressable, StyleProp, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';
import { Row } from './layout';
import { usePressScale } from './motion';
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
}

/**
 * Visual height of one segment. Deliberately shorter than the 44pt minimum so
 * that the segment *plus* the track's 3pt padding and 1pt border on each side
 * adds up to exactly `layout.minTouch` (36 + 6 + 2 = 44), matching the density
 * of the native iOS control. The shortfall is made up with `hitSlop`.
 */
const SEGMENT_HEIGHT = 36;

/**
 * iOS-style segmented picker.
 *
 * Each segment is drawn {@link SEGMENT_HEIGHT}pt tall but carries vertical
 * `hitSlop` so its *effective* tab target is a full `layout.minTouch` (44pt).
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
}: SegmentedControlProps<T>) {
  const theme = useTheme();
  // Split the shortfall evenly above and below so the effective target is
  // centred on the segment. Clamped at 0 in case the constants ever cross over.
  const slop = Math.max(0, Math.round((theme.layout.minTouch - SEGMENT_HEIGHT) / 2));
  const segmentHitSlop = { top: slop, bottom: slop };

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          flexDirection: 'row',
          backgroundColor: theme.colors.surfaceAlt,
          borderRadius: theme.radius.md,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
          padding: 3,
          gap: 3,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, disabled: Boolean(option.disabled) }}
            disabled={option.disabled}
            hitSlop={segmentHitSlop}
            onPress={() => {
              if (selected || option.disabled) return;
              haptic('selection');
              onChange(option.value);
            }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: SEGMENT_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.space.xs,
              borderRadius: theme.radius.sm,
              backgroundColor: selected ? theme.colors.accent : 'transparent',
              opacity: option.disabled ? 0.4 : pressed ? 0.8 : 1,
            })}
          >
            <Txt
              variant="caption"
              numberOfLines={1}
              color={selected ? theme.colors.onAccent : theme.colors.textDim}
              style={{ fontWeight: '700' }}
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

/** A row in a list. Non-interactive when no `onPress` is supplied. */
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
  const press = usePressScale(0.99);
  const interactive = Boolean(onPress || onLongPress);

  const handlePress = useCallback(() => {
    if (disabled || !onPress) return;
    haptic('light');
    onPress();
  }, [disabled, onPress]);

  const rowStyle = {
    minHeight: theme.layout.minTouch + 8,
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.sm + 2,
    borderRadius: theme.radius.md,
    backgroundColor: selected ? theme.colors.accentSoft : 'transparent',
    opacity: disabled ? 0.45 : 1,
  } as const;

  const content = (
    <>
      {leading ? <View accessibilityElementsHidden>{leading}</View> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt
          variant={mono ? 'mono' : 'bodyStrong'}
          numberOfLines={1}
          color={destructive ? theme.colors.bad : theme.colors.text}
        >
          {title}
        </Txt>
        {subtitle ? (
          // A selected row paints the translucent accentSoft fill behind this
          // text, and textFaint drops to ~3.8:1 once that fill is composited
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
      <Row gap="sm" style={[{ borderRadius: theme.radius.md }, style]}>
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
          accessibilityHint={accessibilityHint}
          accessibilityState={{ disabled, selected }}
          disabled={disabled}
          onPress={handlePress}
          onLongPress={onLongPress}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          style={{ flex: 1 }}
        >
          <Row gap="sm" style={rowStyle}>{content}</Row>
        </Pressable>
        <View style={{ paddingRight: theme.space.sm }}>{trailing}</View>
      </Row>
    );
  }

  const body = <Row gap="sm" style={rowStyle}>{content}</Row>;

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
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={style}
    >
      {body}
    </Pressable>
  );
}
