// Text entry. Used for host/port entry on the connect screen, the terminal
// prompt and file rename dialogs, so it supports mono mode and submit handling.

import React, { useCallback, useState } from 'react';
import {
  KeyboardTypeOptions,
  ReturnKeyTypeOptions,
  StyleProp,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { Label, Txt } from './text';

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
  leading,
  trailing,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: InputProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  const invalid = Boolean(error);
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
          paddingHorizontal: theme.space.sm + 2,
          paddingVertical: multiline ? theme.space.sm : 0,
          backgroundColor: theme.colors.surfaceAlt,
          borderRadius: theme.radius.md,
          borderWidth: focused || invalid ? 2 : theme.layout.hairline,
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
