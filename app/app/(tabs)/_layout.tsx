// Bottom tab bar for the five control surfaces.
//
// Ledger treatment: the bar is the page surface with a hairline top rule —
// not a floating chrome slab — and each item is a 1.5pt-outline glyph over a
// wide-tracked mono micro-label. Icons stay (they beat the reference's
// text-only nav on discoverability), but they are strokes in the label's own
// colour, never filled blobs (docs/DESIGN.md §11.1); selection is the accent
// tint plus a steady 2pt underline track beneath the glyph, so nothing
// pulses, slides or squishes down here — scenes crossfade, the bar holds.
//
// Icons stay hand-drawn from Views: @expo/vector-icons is not a dependency of
// this app, and adding an icon font purely for five glyphs would cost a
// network fetch on web for no visual gain.

import React from 'react';
import { PixelRatio, Text, View } from 'react-native';
import type { ColorValue, ViewStyle } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { font, useTheme } from '../../src/theme';
import type { Theme } from '../../src/theme';
import { waitingSessions } from '../../src/agent/attention';
import { useAgentAttention, resetAttention } from '../../src/agent/attention-store';
import { NeedsYouBanner } from '../../src/agent/needs-you-banner';

type TabName = 'screen' | 'agent' | 'terminal' | 'files' | 'system';

/** The one stroke weight every glyph is drawn with — a thin outline. */
const STROKE = 1.5;

const GLYPH_BOX: ViewStyle = { alignItems: 'center', justifyContent: 'center', width: 24, height: 24 };

/** The steady selection mark: a 2pt accent track under the active glyph. */
const TRACK_WIDTH = 20;
const TRACK_HEIGHT = 2;

/** Monitor outline with a stand. */
function ScreenGlyph({ color }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View style={{ width: 22, height: 15, borderRadius: 2, borderWidth: STROKE, borderColor: color }} />
      <View style={{ width: 9, height: STROKE, backgroundColor: color, marginTop: 2.5 }} />
    </View>
  );
}

/** A spark: a rotated square with a point at its centre — "something is working for you". */
function AgentGlyph({ color }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 2,
          borderWidth: STROKE,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
      <View style={{ position: 'absolute', width: 3, height: 3, borderRadius: 1.5, backgroundColor: color }} />
    </View>
  );
}

/** Terminal window with a prompt. */
function TerminalGlyph({ color }: GlyphProps) {
  return (
    <View style={[GLYPH_BOX, { borderRadius: 2, borderWidth: STROKE, borderColor: color }]}>
      <Text allowFontScaling={false} style={{ color, fontFamily: font.mono, fontSize: 10, marginTop: -1 }}>
        {'>_'}
      </Text>
    </View>
  );
}

/** Folder with a tab. */
function FilesGlyph({ color }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View
        style={{
          position: 'absolute',
          top: 3.5,
          left: 2,
          width: 9,
          height: 5,
          borderTopWidth: STROKE,
          borderLeftWidth: STROKE,
          borderRightWidth: STROKE,
          borderColor: color,
          borderTopLeftRadius: 2,
          borderTopRightRadius: 2,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 6,
          width: 20,
          height: 14,
          borderRadius: 2,
          borderWidth: STROKE,
          borderColor: color,
          backgroundColor: 'transparent',
        }}
      />
    </View>
  );
}

/** Three-bar activity chart — outlined, so it matches the stroke language. */
function SystemGlyph({ color }: GlyphProps) {
  const bar = (height: number): ViewStyle => ({
    width: 5,
    height,
    borderWidth: STROKE,
    borderColor: color,
    borderRadius: 1,
  });
  return (
    <View style={[GLYPH_BOX, { flexDirection: 'row', alignItems: 'flex-end', gap: 2.5 }]}>
      <View style={bar(8)} />
      <View style={bar(16)} />
      <View style={bar(11)} />
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
}

const GLYPHS: Record<TabName, (props: GlyphProps) => React.JSX.Element> = {
  screen: ScreenGlyph,
  agent: AgentGlyph,
  terminal: TerminalGlyph,
  files: FilesGlyph,
  system: SystemGlyph,
};

/** Static glyph slot — selection is colour plus the underline track, never
 *  animation or a filled pill. The track is always laid out (transparent at
 *  rest) so selecting a tab moves nothing. */
function TabIcon({ name, color, focused }: { name: TabName; color: ColorValue; focused: boolean }) {
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
      <Glyph color={color} />
      <View
        style={{
          position: 'absolute',
          bottom: 2,
          width: TRACK_WIDTH,
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          backgroundColor: focused ? color : 'transparent',
        }}
      />
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
const TAB_LABEL_FONT_SIZE = 10;
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

/**
 * The complete bar style — the navy page surface with its hairline top rule,
 * sized from the scaled contents plus the home-indicator inset.
 *
 * Exported for screen.tsx's fullscreen toggle: a route-level `tabBarStyle`
 * replaces the navigator's wholesale, so restoring with `undefined` after
 * fullscreen left react-navigation's default white bar. The Screen tab must
 * hand back this exact style instead.
 */
export function tabBarStyleFor(theme: Theme, bottomInset: number, fontScale: number): ViewStyle {
  return {
    // The bar sits on the page itself — one surface, a hairline rule,
    // no shadow slab floating over the content.
    backgroundColor: theme.colors.bg,
    borderTopColor: theme.colors.border,
    borderTopWidth: theme.layout.hairline,
    // Sized from the icon and the scaled label, so nothing is clipped at
    // any text size. The home-indicator inset is added on top rather than
    // eating into that content box.
    height: tabBarContentHeight(fontScale) + bottomInset,
    paddingTop: TAB_BAR_PAD_TOP,
    paddingBottom: TAB_BAR_PAD_BOTTOM + bottomInset,
  };
}

const TABS: readonly { readonly name: TabName; readonly title: string }[] = [
  { name: 'screen', title: 'Screen' },
  { name: 'agent', title: 'Agent' },
  { name: 'terminal', title: 'Terminal' },
  { name: 'files', title: 'Files' },
  { name: 'system', title: 'System' },
];

export default function TabsLayout() {
  const { ready, connection, devices, phase } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const fontScale = PixelRatio.getFontScale();
  const contentHeight = tabBarContentHeight(fontScale);
  const itemHeight = tabItemHeight(fontScale);
  // Mounting the attention store here keeps the session list current for the
  // whole app; the count drives the Agent tab badge and the banner below.
  const { sessions } = useAgentAttention();
  const waitingCount = waitingSessions(sessions ?? []).length;

  // The attention store is module-level and its sessions/openId/approvals are
  // scoped to one host. When the active computer changes, wipe them so a
  // quick-switch can't leave the old host's session open (a dead
  // `/ws/agent?session=<old-id>` against the new host) or POST its pending
  // approval to the wrong machine. Keyed on host, so a plain reconnect to the
  // same computer keeps the open session.
  const host = connection?.host ?? null;
  const prevHostRef = React.useRef<string | null>(host);
  React.useEffect(() => {
    if (prevHostRef.current !== host) {
      if (prevHostRef.current !== null) resetAttention();
      prevHostRef.current = host;
    }
  }, [host]);

  // Guard: never show the tabs without a live connection. Where to send the
  // user depends on why there isn't one — with no computers saved they need the
  // add flow, otherwise they need the list, which can say what went wrong.
  if (ready && !connection && phase !== 'connecting') {
    return <Redirect href={devices.length > 0 ? '/devices' : '/'} />;
  }

  return (
    <View style={{ flex: 1 }}>
    <Tabs
      screenOptions={{
        headerShown: false,
        // Tab switches crossfade; the bar itself holds perfectly still.
        animation: 'fade',
        // Freeze inactive tabs (react-native-screens): a blurred tab stops
        // re-rendering and running its effects, so switching is snappy instead
        // of fighting five live screens (stream, polls) at once.
        freezeOnBlur: true,
        // Selection = the accent; rest state = the micro-label's usual textDim.
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textDim,
        // The label is redundant next to the icon for screen readers.
        tabBarAccessibilityLabel: undefined,
        tabBarStyle: tabBarStyleFor(theme, insets.bottom, fontScale),
        // Sized to its contents, with the default vertical padding removed so the
        // label keeps its full line box instead of being shrunk and clipped.
        tabBarItemStyle: { height: itemHeight, paddingTop: 0, paddingBottom: 0 },
        // The `micro` style, inlined: navigation options cannot spread a theme
        // TextStyle that includes lineHeight without re-triggering the clipping
        // the sizing maths above exists to prevent.
        tabBarLabelStyle: {
          fontFamily: font.mono,
          fontSize: TAB_LABEL_FONT_SIZE,
          fontWeight: '400',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
        },
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
            // The one tab allowed a badge: sessions blocked on an approval.
            // Accent, not red — it means "decide", not "broken".
            ...(name === 'agent' && waitingCount > 0
              ? {
                  tabBarBadge: waitingCount,
                  // A small SQUARE count chip (radius 2) — the reference's
                  // geometry, not the platform pill.
                  tabBarBadgeStyle: {
                    backgroundColor: theme.colors.accent,
                    color: theme.colors.onAccent,
                    fontFamily: font.mono,
                    fontSize: 10,
                    borderRadius: 2,
                  },
                }
              : null),
          }}
        />
      ))}
    </Tabs>
    <NeedsYouBanner bottom={contentHeight + insets.bottom} />
    </View>
  );
}
