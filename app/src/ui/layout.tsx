// Structural primitives: page shell, rows, cards, dividers and list rows.

import React from 'react';
import { ScrollView, StyleProp, View, ViewStyle } from 'react-native';
import { Edge, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

export type SpaceKey = 'none' | 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export interface ScreenProps {
  children: React.ReactNode;
  /** Wraps the content in a ScrollView. Defaults to false. */
  scroll?: boolean;
  /** Horizontal + vertical content padding. Defaults to `md`. */
  padding?: SpaceKey;
  /** Which safe-area edges to inset. Defaults to top + horizontal. */
  edges?: readonly Edge[];
  /** Overrides the page background (defaults to `colors.bg`). */
  background?: string;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

const DEFAULT_EDGES: readonly Edge[] = ['top', 'left', 'right'];

/**
 * Page shell. Applies the themed background, safe-area insets and a max content
 * width so the layout does not sprawl on web or tablet.
 */
export function Screen({
  children,
  scroll = false,
  padding = 'md',
  edges = DEFAULT_EDGES,
  background,
  style,
  contentStyle,
  testID,
}: ScreenProps) {
  const theme = useTheme();
  const pad = theme.space[padding];
  const inner: StyleProp<ViewStyle> = [
    { padding: pad, width: '100%', maxWidth: theme.layout.contentMaxWidth, alignSelf: 'center' },
    contentStyle,
  ];

  return (
    <SafeAreaView
      testID={testID}
      edges={edges as Edge[]}
      style={[{ flex: 1, backgroundColor: background ?? theme.colors.bg }, style]}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={inner}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, inner]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

/** Bottom safe-area spacer, for content sitting above the tab bar. */
export function SafeBottomSpacer({ extra = 0 }: { extra?: number }) {
  const insets = useSafeAreaInsets();
  return <View style={{ height: insets.bottom + extra }} />;
}

export type Elevation = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Shadow depth. Defaults to `sm`. */
  elevation?: Elevation;
  padding?: SpaceKey;
  /** Uses the raised `surfaceAlt` fill instead of `surface`. */
  raised?: boolean;
  testID?: string;
}

/** Surface container. Legacy signature — `{ children, style }` — preserved. */
export function Card({ children, style, elevation = 'sm', padding = 'md', raised, testID }: CardProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: raised ? theme.colors.surfaceAlt : theme.colors.surface,
          borderRadius: theme.radius.lg,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
          padding: theme.space[padding],
        },
        theme.elevation[elevation],
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface RowProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Shorthand for a `gap` between children. */
  gap?: SpaceKey;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  wrap?: boolean;
  testID?: string;
}

/** Horizontal stack. Legacy signature — `{ children, style }` — preserved. */
export function Row({ children, style, gap, align = 'center', justify, wrap, testID }: RowProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: justify,
          gap: gap ? theme.space[gap] : undefined,
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface ColumnProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: SpaceKey;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  testID?: string;
}

/** Vertical stack with an optional gap. */
export function Column({ children, style, gap, align, justify, testID }: ColumnProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'column',
          alignItems: align,
          justifyContent: justify,
          gap: gap ? theme.space[gap] : undefined,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Fixed gap, or a flexible spring when `flex` is set. */
export function Spacer({ size = 'md', flex }: { size?: SpaceKey; flex?: boolean }) {
  const theme = useTheme();
  if (flex) return <View style={{ flex: 1 }} />;
  return <View style={{ height: theme.space[size], width: theme.space[size] }} />;
}

/** Hairline rule. Decorative, so it is hidden from screen readers. */
export function Divider({ inset = 0, vertical, style }: { inset?: number; vertical?: boolean; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        vertical
          ? { width: theme.layout.hairline, alignSelf: 'stretch', marginVertical: inset }
          : { height: theme.layout.hairline, marginHorizontal: inset },
        { backgroundColor: theme.colors.border },
        style,
      ]}
    />
  );
}
