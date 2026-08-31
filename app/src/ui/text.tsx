// Typography primitives. Everything routes through <Txt> so the type scale,
// colour roles and Dynamic Type caps are applied in exactly one place.
//
// Under the Ledger system typography IS the hierarchy (docs/DESIGN.md §2), so
// these components carry more of the design than any other file: <Label> is
// the wide-tracked mono micro-label that marks every section, ledger key, tab
// and quiet button, and its default tone/casing are load-bearing.

import React from 'react';
import { Text } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { useTheme } from '../theme';
import type { TypeVariant } from '../theme';

export type TextTone =
  | 'default'
  | 'dim'
  | 'faint'
  | 'accent'
  | 'good'
  | 'warn'
  | 'bad'
  | 'onAccent'
  | 'onMachine'
  | 'onMachineDim';

/**
 * Per-variant Dynamic Type ceilings. Body copy is allowed to grow a long way;
 * display/title/label live in fixed chrome where unbounded growth destroys the
 * layout, so they are capped tighter (docs/DESIGN.md §4.4).
 */
const MAX_SCALE: Readonly<Record<TypeVariant, number>> = {
  display: 1.2,
  title: 1.2,
  heading: 1.5,
  subheading: 1.5,
  body: 1.8,
  bodyStrong: 1.8,
  caption: 1.8,
  numeral: 1.3,
  label: 1.3,
  micro: 1.3,
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
    onMachine: theme.colors.onMachine,
    onMachineDim: theme.colors.onMachineDim,
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
 * The micro-label: wide-tracked uppercase mono, the universal section marker.
 * Usually `textDim`, going `text` when its section is active and `accent` only
 * when selected — never bold, never larger than 11pt (docs/DESIGN.md §4.3).
 * Legacy signature took only `children`; the extras are additive.
 */
export function Label({ children, style, numberOfLines, testID, tone = 'dim' }: SimpleTextProps & { tone?: TextTone }) {
  const theme = useTheme();
  return (
    <Txt
      variant="label"
      tone={tone}
      numberOfLines={numberOfLines}
      testID={testID}
      style={[{ marginBottom: theme.space.xs }, style]}
    >
      {children}
    </Txt>
  );
}

/**
 * The sub-label for dense chrome: key-bar hints, feed timestamps. Smaller than
 * <Label> and carries no default margin because it sits inline.
 */
export function Micro({ children, style, numberOfLines, testID, tone = 'faint' }: SimpleTextProps & { tone?: TextTone }) {
  return (
    <Txt variant="micro" tone={tone} numberOfLines={numberOfLines} testID={testID} style={style}>
      {children}
    </Txt>
  );
}

/** Monospaced text for paths, command output and IDs — the machine's voice. */
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
