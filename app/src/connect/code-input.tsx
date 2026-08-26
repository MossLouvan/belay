// Segmented pairing-code entry.
//
// One real TextInput sits invisibly over a row of digit boxes. That keeps paste,
// autofill, the numeric keypad, screen-reader focus and (on web) automation all
// working exactly as they would for an ordinary field, while the boxes render
// the value with proper per-digit feedback.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, TextInput, TextStyle, View } from 'react-native';
import { useTheme } from '../theme';
import { Txt, useReducedMotion } from '../ui';

export interface CodeInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired when the keyboard's submit key is pressed on a complete code. */
  onSubmit?: () => void;
  length?: number;
  editable?: boolean;
  /** Paints the boxes in the error colour without changing the value. */
  invalid?: boolean;
  autoFocus?: boolean;
  testID?: string;
}

const DEFAULT_LENGTH = 6;
const BOX_HEIGHT = 62;
const CARET_BLINK_MS = 560;

const digitsOnly = (raw: string, length: number): string => raw.replace(/[^0-9]/g, '').slice(0, length);

/**
 * The browser paints its own focus ring around the invisible input, which lands
 * on the whole row rather than the active box. The boxes already render a
 * high-contrast focus treatment, so the default ring is redundant here — and
 * only here. `outlineStyle` is a react-native-web style extension, hence the
 * cast; it is inert on native, so it is applied on web only.
 */
const NO_WEB_OUTLINE: TextStyle | null =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

/** Blinking caret for the box currently accepting input. */
function Caret({ color, visible }: { color: string; visible: boolean }) {
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!visible || reduced) {
      opacity.setValue(visible ? 1 : 0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: CARET_BLINK_MS, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacity, { toValue: 1, duration: CARET_BLINK_MS, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, reduced, opacity]);

  if (!visible) return null;
  return <Animated.View style={{ width: 2, height: 24, borderRadius: 1, backgroundColor: color, opacity }} />;
}

interface BoxProps {
  digit: string;
  active: boolean;
  invalid: boolean;
}

function Box({ digit, active, invalid }: BoxProps) {
  const theme = useTheme();
  const border = invalid ? theme.colors.bad : active ? theme.colors.focus : theme.colors.border;
  const fill = invalid ? theme.colors.badSoft : active ? theme.colors.accentSoft : theme.colors.surfaceAlt;

  return (
    <View
      style={{
        flex: 1,
        height: BOX_HEIGHT,
        borderRadius: theme.radius.md,
        borderWidth: active || invalid ? 2 : theme.layout.hairline,
        borderColor: border,
        backgroundColor: fill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {digit ? (
        <Txt variant="title" color={invalid ? theme.colors.onBadSoft : theme.colors.text}>
          {digit}
        </Txt>
      ) : (
        <Caret color={theme.colors.focus} visible={active} />
      )}
    </View>
  );
}

/**
 * Six-digit code field. `value` is always the digits-only string, so callers
 * never have to sanitise it themselves.
 */
export function CodeInput({
  value,
  onChange,
  onSubmit,
  length = DEFAULT_LENGTH,
  editable = true,
  invalid = false,
  autoFocus = false,
  testID,
}: CodeInputProps) {
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const handleChange = useCallback(
    (raw: string) => onChange(digitsOnly(raw, length)),
    [onChange, length]
  );

  const handleSubmit = useCallback(() => {
    if (value.length === length) onSubmit?.();
  }, [value.length, length, onSubmit]);

  const focus = useCallback(() => input.current?.focus(), []);

  const digits = Array.from({ length }, (_, i) => value[i] ?? '');
  // The caret sits on the next empty box, or on the last box once full.
  const activeIndex = Math.min(value.length, length - 1);

  return (
    <Pressable
      accessible={false}
      onPress={focus}
      style={{ opacity: editable ? 1 : 0.5 }}
    >
      <View style={{ flexDirection: 'row', gap: theme.space.xs }}>
        {digits.map((digit, index) => (
          <Box
            key={index}
            digit={digit}
            active={editable && focused && index === activeIndex}
            invalid={invalid}
          />
        ))}
      </View>
      <TextInput
        ref={input}
        testID={testID}
        value={value}
        onChangeText={handleChange}
        onSubmitEditing={handleSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={editable}
        autoFocus={autoFocus}
        caretHidden
        maxLength={length}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        returnKeyType="go"
        selectionColor="transparent"
        accessibilityLabel={`Pairing code, ${length} digits`}
        accessibilityHint="Enter the code shown in the Tether window on your PC"
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: BOX_HEIGHT,
            // Transparent glyphs: the boxes underneath are what the user reads.
            color: 'transparent',
            backgroundColor: 'transparent',
            textAlign: 'center',
            fontSize: 24,
          },
          NO_WEB_OUTLINE,
        ]}
      />
    </Pressable>
  );
}
