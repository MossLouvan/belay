// Bottom tab bar for the four control surfaces.
//
// Icons stay hand-drawn from Views: @expo/vector-icons is not a dependency of
// this app, and adding an icon font purely for four glyphs would cost a network
// fetch on web for no visual gain. Each glyph gets a filled/active treatment so
// selection reads at a glance.

import React from 'react';
import { Animated, ColorValue, PixelRatio, Platform, Text, View, ViewStyle } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { useTheme } from '../../src/theme';
import { useToggleAnimation } from '../../src/ui';

type TabName = 'screen' | 'terminal' | 'files' | 'system';

const GLYPH_BOX: ViewStyle = { alignItems: 'center', justifyContent: 'center', width: 24, height: 24 };

/** Monitor outline with a stand. */
function ScreenGlyph({ color, active }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View
        style={{
          width: 22,
          height: 15,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: color,
          backgroundColor: active ? color : 'transparent',
          opacity: active ? 0.9 : 1,
        }}
      />
      <View style={{ width: 9, height: 2, backgroundColor: color, marginTop: 2.5, borderRadius: 1 }} />
    </View>
  );
}

/** Terminal window with a prompt. */
function TerminalGlyph({ color, active, onActive }: GlyphProps) {
  return (
    <View style={[GLYPH_BOX, { borderRadius: 5, borderWidth: 2, borderColor: color, backgroundColor: active ? color : 'transparent' }]}>
      <Text allowFontScaling={false} style={{ color: active ? onActive : color, fontSize: 11, fontWeight: '900', marginTop: -1 }}>
        {'>_'}
      </Text>
    </View>
  );
}

/** Folder with a tab. */
function FilesGlyph({ color, active }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View style={{ position: 'absolute', top: 3.5, left: 2, width: 9, height: 4, backgroundColor: color, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
      <View
        style={{
          position: 'absolute',
          top: 6,
          width: 20,
          height: 14,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: color,
          backgroundColor: active ? color : 'transparent',
        }}
      />
    </View>
  );
}

/** Three-bar activity chart. */
function SystemGlyph({ color, active }: GlyphProps) {
  const bar = (height: number, dim: boolean): ViewStyle => ({
    width: 4,
    height,
    backgroundColor: color,
    borderRadius: 2,
    opacity: active || !dim ? 1 : 0.75,
  });
  return (
    <View style={[GLYPH_BOX, { flexDirection: 'row', alignItems: 'flex-end', gap: 2.5 }]}>
      <View style={bar(8, true)} />
      <View style={bar(16, false)} />
      <View style={bar(11, true)} />
    </View>
  );
}

interface GlyphProps {
  /**
   * Current tint — the active or inactive tab colour. Typed as ColorValue
   * because that is what the navigator hands its icon renderer; it covers
   * platform colour objects as well as plain strings.
   */
  color: ColorValue;
  active: boolean;
  /** Foreground to use on top of a `color`-filled shape. */
  onActive: string;
}

const GLYPHS: Record<TabName, (props: GlyphProps) => React.JSX.Element> = {
  screen: ScreenGlyph,
  terminal: TerminalGlyph,
  files: FilesGlyph,
  system: SystemGlyph,
};

/**
 * Wraps a glyph with the active-state treatment: a soft accent pill that fades
 * and lifts in. `useToggleAnimation` no-ops when reduced motion is enabled.
 */
function TabIcon({ name, color, focused }: { name: TabName; color: ColorValue; focused: boolean }) {
  const theme = useTheme();
  const progress = useToggleAnimation(focused, theme.motion.fast);
  const Glyph = GLYPHS[name];

  return (
    // Hidden from assistive tech: the tab's own label already names it, and the
    // terminal glyph's ">_" text would otherwise be read as part of that name.
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{ width: TAB_ICON_WIDTH, height: TAB_ICON_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          width: 52,
          height: 30,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accentSoft,
          opacity: progress,
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
        }}
      />
      <Animated.View style={{ transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }] }}>
        <Glyph color={color} active={focused} onActive={theme.colors.onAccent} />
      </Animated.View>
    </View>
  );
}

/**
 * The tab bar sizes itself from what it actually holds. A fixed height clipped
 * the bottom of every label, and clipped it worse at larger text sizes, since
 * labels scale with Dynamic Type but a constant does not.
 */
const TAB_ICON_HEIGHT = 32;
const TAB_ICON_WIDTH = 56;
const TAB_LABEL_FONT_SIZE = 11;
const TAB_LABEL_LINE_RATIO = 1.35;
const TAB_BAR_PAD_TOP = 6;
const TAB_BAR_PAD_BOTTOM = 8;
/** Breathing room so the label is never the thing flex decides to shrink. */
const TAB_ITEM_SLACK = 4;

/**
 * Height one tab needs: the icon, its label, and a little slack.
 *
 * The label is a flex child with `overflow: hidden`, so if the item is shorter
 * than its contents the label is silently shrunk and sliced through the middle
 * rather than overflowing visibly. Sizing the item from its contents is what
 * actually prevents that — making only the bar taller leaves the item starved.
 */
function tabItemHeight(fontScale: number): number {
  const label = Math.ceil(TAB_LABEL_FONT_SIZE * TAB_LABEL_LINE_RATIO * fontScale);
  return TAB_ICON_HEIGHT + label + TAB_ITEM_SLACK;
}

function tabBarContentHeight(fontScale: number): number {
  return tabItemHeight(fontScale) + TAB_BAR_PAD_TOP + TAB_BAR_PAD_BOTTOM;
}

const TABS: readonly { readonly name: TabName; readonly title: string }[] = [
  { name: 'screen', title: 'Screen' },
  { name: 'terminal', title: 'Terminal' },
  { name: 'files', title: 'Files' },
  { name: 'system', title: 'System' },
];

export default function TabsLayout() {
  const { ready, connection } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const fontScale = PixelRatio.getFontScale();
  const contentHeight = tabBarContentHeight(fontScale);
  const itemHeight = tabItemHeight(fontScale);

  // Guard: never show the tabs without a connection.
  if (ready && !connection) return <Redirect href="/" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textFaint,
        // The label is redundant next to the icon for screen readers.
        tabBarAccessibilityLabel: undefined,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: theme.layout.hairline,
          // Sized from the icon and the scaled label, so nothing is clipped at
          // any text size. The home-indicator inset is added on top rather than
          // eating into that content box.
          height: contentHeight + insets.bottom,
          paddingTop: TAB_BAR_PAD_TOP,
          paddingBottom: TAB_BAR_PAD_BOTTOM + insets.bottom,
          ...(Platform.OS === 'web' ? {} : theme.elevation.md),
        },
        // Sized to its contents, with the default vertical padding removed so the
        // label keeps its full line box instead of being shrunk and clipped.
        tabBarItemStyle: { height: itemHeight, paddingTop: 0, paddingBottom: 0 },
        tabBarLabelStyle: { fontSize: TAB_LABEL_FONT_SIZE, fontWeight: '700', letterSpacing: 0.2 },
        tabBarAllowFontScaling: true,
      }}
    >
      {TABS.map(({ name, title }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ color, focused }) => <TabIcon name={name} color={color} focused={focused} />,
          }}
        />
      ))}
    </Tabs>
  );
}
