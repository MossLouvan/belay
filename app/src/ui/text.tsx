// Typography primitives. Everything routes through <Txt> so the type scale,
// colour roles and Dynamic Type caps are applied in exactly one place.

import React from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { TypeVariant, useTheme } from '../theme';

export type TextTone = 'default' | 'dim' | 'faint' | 'accent' | 'good' | 'warn' | 'bad' | 'onAccent';

/**
 * Per-variant Dynamic Type ceilings. Body copy is allowed to grow a long way;
 * headings and all-caps labels are capped tighter because they sit in fixed
 * chrome where unbounded growth destroys the layout.
 */
const MAX_SCALE: Readonly<Record<TypeVariant, number>> = {
  display: 1.4,
  title: 1.4,
  heading: 1.5,
  subheading: 1.5,
  body: 1.8,
  bodyStrong: 1.8,
  caption: 1.8,
  label: 1.3,
  mono: 1.5,
  monoSmall: 1.5,
};

export interface TxtProps {
  children: React.ReactNode;
  variant?: TypeVariant;
  tone?: TextTone;
  color?: string;
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
  /** Marks the text as a heading for screen readers. */
  heading?: boolean;
}

/** The base text component. Prefer the named wrappers below where they fit. */
export function Txt({
  children,
  variant = 'body',
  tone = 'default',
  color,
  align,
  numberOfLines,
  selectable,
  style,
  testID,
  accessibilityLabel,
  heading,
}: TxtProps) {
  const theme = useTheme();
  const tones: Record<TextTone, string> = {
    default: theme.colors.text,
    dim: theme.colors.textDim,
    faint: theme.colors.textFaint,
    accent: theme.colors.accent,
    good: theme.colors.good,
    warn: theme.colors.warn,
    bad: theme.colors.bad,
    onAccent: theme.colors.onAccent,
  };

  return (
    <Text
      testID={testID}
      accessibilityRole={heading ? 'header' : undefined}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      selectable={selectable}
      maxFontSizeMultiplier={MAX_SCALE[variant]}
      style={[theme.type[variant] as TextStyle, { color: color ?? tones[tone], textAlign: align }, style]}
    >
      {children}
    </Text>
  );
}

interface SimpleTextProps {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}

/** Screen title. Legacy signature — `{ children, style }` — preserved. */
export function Heading({ children, style, numberOfLines, testID }: SimpleTextProps) {
  return (
    <Txt variant="title" heading numberOfLines={numberOfLines} testID={testID} style={style}>
      {children}
    </Txt>
  );
}

/** Secondary/supporting copy. Legacy signature preserved. */
export function Sub({ children, style, numberOfLines, testID }: SimpleTextProps) {
  return (
    <Txt variant="body" tone="dim" numberOfLines={numberOfLines} testID={testID} style={style}>
      {children}
    </Txt>
  );
}

/**
 * All-caps section label. Legacy signature took only `children`; `style` is
 * additive and optional so existing call sites are unaffected.
 */
export function Label({ children, style, testID }: SimpleTextProps) {
  const theme = useTheme();
  return (
    <Txt variant="label" tone="faint" testID={testID} style={[{ marginBottom: theme.space.xs }, style]}>
      {children}
    </Txt>
  );
}

/** Monospaced text for paths, command output and IDs. */
export function Mono({ children, style, numberOfLines, testID }: SimpleTextProps) {
  return (
    <Txt variant="mono" tone="dim" numberOfLines={numberOfLines} testID={testID} style={style} selectable>
      {children}
    </Txt>
  );
}

/** Small print. */
export function Caption({ children, style, numberOfLines, testID }: SimpleTextProps) {
  return (
    <Txt variant="caption" tone="faint" numberOfLines={numberOfLines} testID={testID} style={style}>
      {children}
    </Txt>
  );
}
