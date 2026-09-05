// Text entry. Used for host/port entry on the connect screen, the terminal
// prompt and file rename dialogs, so it supports mono mode and submit handling.
//
// The input is one of only four filled rectangles the Ledger system allows
// (docs/DESIGN.md §2.1) — a `surface` lift with a hairline border and 2pt
// corners, so it reads as a slot cut into the page rather than a floating pill.
//
// Signature detail (REVAMP-SPEC §5.10): on focus the hairline swaps to the
// `focus` colour and a 2pt `accentGraphic` track — the rope — grows along the
// bottom edge under the caret, tensioning in over `motion.fast`.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Platform, TextInput, View } from 'react-native';
import type { KeyboardTypeOptions, ReturnKeyTypeOptions, StyleProp, ViewStyle } from 'react-native';
import { easing, useTheme } from '../theme';
import { useReducedMotion } from './motion';
import { Label, Txt } from './text';

// react-native-web does not meaningfully support the native driver.
const USE_NATIVE_DRIVER = Platform.OS !== 'web';

export interface InputProps {
  value: string;
  onChangeText: (next: string) => void;
  label?: string;
  placeholder?: string;
  /** Validation message. Its presence puts the field in the error state. */
  error?: string;
  /** Hint shown under the field when there is no error. */
  helper?: string;
  secure?: boolean;
  /** Renders the value and placeholder in the monospace face. */
  mono?: boolean;
  multiline?: boolean;
  numberOfLines?: number;
  editable?: boolean;
  autoFocus?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  keyboardType?: KeyboardTypeOptions;
  returnKeyType?: ReturnKeyTypeOptions;
  onSubmitEditing?: () => void;
  /** What the return key does to focus. 'submit' keeps the keyboard up after
   *  submitting — for fields sent repeatedly, like the screen tab's type-to-PC
   *  row. Default is RN's own (single-line fields blur on submit). */
  submitBehavior?: 'submit' | 'blurAndSubmit' | 'newline';
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Input({
  value,
  onChangeText,
  label,
  placeholder,
  error,
  helper,
  secure,
  mono,
  multiline,
  numberOfLines,
  editable = true,
  autoFocus,
  autoCapitalize = 'none',
  autoCorrect = false,
  keyboardType,
  returnKeyType,
  onSubmitEditing,
  submitBehavior,
  leading,
  trailing,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: InputProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  // The focus rope (REVAMP-SPEC §5.10): 0 → 1 drives both the horizontal
  // growth (scaleX, tensioning out from under the caret) and the fade of the
  // 2pt bottom track. One value, `motion.fast`, `easing.standard` — the same
  // "track ignition" vocabulary as every other rope in the app (§3.5).
  // Reduced motion: translations/growth become fades (§3.5), so the scale is
  // pinned at 1 and only the crossfade remains.
  const rope = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(rope, {
      toValue: focused ? 1 : 0,
      duration: reducedMotion ? theme.motion.fast / 2 : theme.motion.fast,
      easing: easing.standard,
      useNativeDriver: USE_NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [focused, reducedMotion, rope, theme.motion.fast]);

  const invalid = Boolean(error);
  // Focus swaps the hairline to `focus`; the rope carries the emphasis weight.
  // Error keeps its 2pt promotion — a fault is structural, not a caret state.
  const borderColor = invalid ? theme.colors.bad : focused ? theme.colors.focus : theme.colors.border;

  return (
    <View style={style}>
      {label ? <Label>{label}</Label> : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          gap: theme.space.xs,
          minHeight: theme.layout.minTouch,
          paddingHorizontal: theme.space.sm,
          paddingVertical: multiline ? theme.space.sm : 0,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.xs,
          // Error promotes the hairline to the 2pt emphasis weight; focus
          // stays a hairline (recoloured to `focus`) because the rope below
          // now carries the 2pt emphasis (REVAMP-SPEC §5.10).
          borderWidth: invalid ? theme.layout.ruleEmphasis : theme.layout.hairline,
          borderColor,
          opacity: editable ? 1 : 0.55,
        }}
      >
        {leading ? <View accessibilityElementsHidden>{leading}</View> : null}
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textFaint}
          secureTextEntry={secure}
          multiline={multiline}
          numberOfLines={numberOfLines}
          editable={editable}
          autoFocus={autoFocus}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          keyboardType={keyboardType}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          submitBehavior={submitBehavior}
          onFocus={onFocus}
          onBlur={onBlur}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={accessibilityHint}
          accessibilityState={{ disabled: !editable }}
          style={{
            flex: 1,
            color: theme.colors.text,
            fontSize: 15,
            lineHeight: 20,
            paddingVertical: multiline ? 0 : theme.space.sm + 2,
            fontFamily: mono ? theme.font.mono : undefined,
          }}
        />
        {trailing ? <View>{trailing}</View> : null}
        {/* The focus rope: a 2pt accentGraphic track along the bottom edge,
            grown over motion.fast on focus (REVAMP-SPEC §5.10). Grows from
            left edge (transformOrigin left) to match the caret position.
            Decorative — focus state is already announced by the field itself. */}
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            pointerEvents: 'none',
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: theme.layout.ruleEmphasis,
            backgroundColor: theme.colors.accentGraphic,
            opacity: rope,
            transform: [{ scaleX: reducedMotion ? 1 : rope }],
            transformOrigin: 'left',
          }}
        />
      </View>
      {error ? (
        <Txt variant="caption" tone="bad" style={{ marginTop: theme.space.xs }} accessibilityLabel={`Error: ${error}`}>
          {error}
        </Txt>
      ) : helper ? (
        <Txt variant="caption" tone="faint" style={{ marginTop: theme.space.xs }}>
          {helper}
        </Txt>
      ) : null}
    </View>
  );
}

export { Input as TextField };
