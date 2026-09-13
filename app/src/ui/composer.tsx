// The composer: the one row a phone types into, and the buttons that send it.
//
// Three surfaces used to hand-roll this — the agent prompt, the Terminal tab's
// command line and the pty session's command line — and they had drifted into
// three different fields (14 vs 15pt text, two paddings, two radii). There is
// only one of them now, and every metric below is read from the type scale,
// the 4pt spacing scale, `layout.minTouch` and `look.controlRadius`: no font
// size, padding or radius is written as a number in this file.
//
// What the three sites genuinely differ on is a prop; what they merely differ
// on by accident is gone. In particular `mono` picks the face (the command
// lines speak the machine's voice, the agent prompt speaks prose) but it does
// NOT decide autocorrect/capitalisation — those are the caller's, because
// getting them wrong turns a shell into a spellchecker.
//
// Keyboard note: this renders no KeyboardAvoidingView of its own. All three
// call sites already sit inside an ancestor `KeyboardAvoider` (ToolPanel), and
// a second one fights the first.

import React from 'react';
import { TextInput, View } from 'react-native';
import type {
  StyleProp,
  TextInputProps,
  TextStyle,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Button, IconButton } from './button';
import type { ButtonVariant } from './button';
import type { HapticTone } from './haptics';
import { Row } from './layout';
import { Txt } from './text';

/** One trailing button. The first is the field's default action. */
export interface ComposerAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly hapticTone?: HapticTone | null;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly testID?: string;
}

/**
 * The field's own way out of the keyboard (docs/DESIGN.md §11.2). Every
 * composer here keeps focus on return, so return can never be the exit.
 */
export interface ComposerDismiss {
  readonly visible: boolean;
  /** The glyph worn by this field — '×' on the prompt, '⌄' on a command line. */
  readonly glyph: string;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
  readonly testID?: string;
}

export interface ComposerProps {
  value: string;
  onChangeText: (next: string) => void;
  /** Trailing buttons, in reading order. At least one, or nothing can be sent. */
  actions: readonly ComposerAction[];
  accessibilityLabel: string;
  placeholder?: string;
  /** A quiet leading glyph outside the field — the command lines' '›'. */
  prompt?: string;
  /** Controls between the prompt and the field — the agent's mic and camera. */
  leading?: React.ReactNode;
  /** Sets the field in the machine's monospace face rather than prose sans. */
  mono?: boolean;
  multiline?: boolean;
  /** Above this a multiline field stops growing and scrolls instead. */
  maxHeight?: number;
  /**
   * Armed: the field takes the focus ink and the 2pt emphasis rule, and its
   * placeholder goes accent. The agent composer wears this while listening.
   */
  emphasis?: boolean;
  dismiss?: ComposerDismiss;
  inputRef?: React.Ref<TextInput>;
  onFocus?: () => void;
  onBlur?: () => void;
  // Keyboard behaviour is never inferred from `mono`: it is what each caller
  // asks for, defaulting to React Native's own.
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
  autoComplete?: TextInputProps['autoComplete'];
  spellCheck?: boolean;
  returnKeyType?: TextInputProps['returnKeyType'];
  submitBehavior?: TextInputProps['submitBehavior'];
  onSubmitEditing?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** Dynamic Type ceiling for a field inside fixed chrome. */
const MAX_FONT_SCALE = 1.4;

export function Composer({
  value,
  onChangeText,
  actions,
  accessibilityLabel,
  placeholder,
  prompt,
  leading,
  mono = false,
  multiline = false,
  maxHeight,
  emphasis = false,
  dismiss,
  inputRef,
  onFocus,
  onBlur,
  autoCapitalize,
  autoCorrect,
  autoComplete,
  spellCheck,
  returnKeyType,
  submitBehavior,
  onSubmitEditing,
  testID,
  style,
}: ComposerProps) {
  const theme = useTheme();
  const look = useLook();

  // The field's type comes straight off the scale — `mono` for the machine's
  // voice, `body` for prose. Nothing here hand-tunes a size.
  const fieldType = (mono ? theme.type.mono : theme.type.body) as TextStyle;

  // A growing multiline field hangs its buttons off the bottom edge; a
  // single-line one centres everything on one line.
  const rowAlign: ViewStyle['alignItems'] = multiline ? 'flex-end' : 'center';
  const dismissAlign: ViewStyle['justifyContent'] = multiline ? 'flex-start' : 'center';
  const trailingPad = dismiss?.visible ? theme.layout.minTouch : theme.space.sm;

  return (
    <Row gap="sm" align={rowAlign} style={style}>
      {prompt ? (
        <Txt variant="mono" tone="dim">
          {prompt}
        </Txt>
      ) : null}
      {leading}
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <TextInput
          ref={inputRef}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          placeholderTextColor={emphasis ? theme.colors.accent : theme.colors.textFaint}
          multiline={multiline}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          returnKeyType={returnKeyType}
          submitBehavior={submitBehavior}
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel={accessibilityLabel}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={{
            ...fieldType,
            // The 44pt touch target the field itself has to clear.
            minHeight: theme.layout.minTouch,
            maxHeight,
            backgroundColor: theme.colors.surface,
            borderRadius: look.controlRadius,
            // Armed promotes the hairline to the 2pt emphasis rule; at rest it
            // is the same whisper every other slot in the page wears.
            borderWidth: emphasis ? theme.layout.ruleEmphasis : theme.layout.hairline,
            borderColor: emphasis ? theme.colors.focus : theme.colors.border,
            color: theme.colors.text,
            paddingHorizontal: theme.space.sm,
            // Clears the trailing dismiss so long input scrolls under the
            // field's edge, not under the glyph.
            paddingRight: trailingPad,
            // A single-line field gets its height from `minHeight`; padding it
            // as well pushes the text off-centre on Android.
            paddingVertical: multiline ? theme.space.sm : 0,
          }}
        />
        {dismiss?.visible ? (
          <View
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              justifyContent: dismissAlign,
            }}
          >
            <IconButton
              testID={dismiss.testID}
              accessibilityLabel={dismiss.accessibilityLabel}
              variant="plain"
              onPress={dismiss.onPress}
            >
              <Txt variant="label" tone="dim">
                {dismiss.glyph}
              </Txt>
            </IconButton>
          </View>
        ) : null}
      </View>
      {actions.map((action) => (
        <Button
          key={action.testID ?? action.label}
          testID={action.testID}
          label={action.label}
          variant={action.variant}
          size="sm"
          onPress={action.onPress}
          disabled={action.disabled}
          hapticTone={action.hapticTone}
          accessibilityLabel={action.accessibilityLabel}
          accessibilityHint={action.accessibilityHint}
        />
      ))}
    </Row>
  );
}
