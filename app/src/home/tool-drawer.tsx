// The tool drawer — the bottom sheet the dock's TOOLS key opens.
//
// Desktop-first IA: the four former tabs live here as labelled, explained
// rows. Each row is glyph + name + one plain line about what opening it gets
// you, so a first-timer never has to guess what "Agent" means before
// committing a tap. The Agent row carries the same waiting-approvals count
// chip the old tab badge did — accent, not red: it means "decide", not
// "broken". Selection navigates to the tool's slide-up panel and closes the
// drawer; the list itself comes from the pure model in tools.ts.

import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { Caption, ConnectionStatus, Micro, Sheet, Txt, haptic } from '../ui';
import { TOOLS, toolBadge, toolRows } from './tools';
import type { ToolSpec } from './tools';
import { ToolGlyph } from './tool-glyphs';
import { useConnection } from '../connection';

/** The old tab badge, reborn on the drawer row: a small SQUARE count chip. */
function CountChip({ count }: { count: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        minWidth: 18,
        height: 18,
        paddingHorizontal: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Micro style={{ color: theme.colors.onAccent, fontFamily: theme.font.mono }}>
        {String(count)}
      </Micro>
    </View>
  );
}

function ToolCard({ tool, badge, onPress }: { tool: ToolSpec; badge: number | null; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`tool-${tool.id}`}
      accessibilityRole="button"
      accessibilityLabel={
        badge !== null
          ? `${tool.title}, ${badge} waiting for you. ${tool.description}`
          : `${tool.title}. ${tool.description}`
      }
      accessibilityHint="Opens over the desktop; close it to come back"
      onPress={() => {
        haptic('light');
        onPress();
      }}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 120,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.md,
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.border,
        padding: theme.space.sm,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flex: 1, gap: theme.space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <ToolGlyph id={tool.id} color={theme.colors.accentGraphic} />
          {badge !== null ? <CountChip count={badge} /> : null}
        </View>
        <Txt variant="bodyStrong">{tool.title}</Txt>
        <Caption numberOfLines={2}>{tool.description}</Caption>
      </View>
      <View style={{ alignSelf: 'flex-end', marginTop: theme.space.xs }}>
        <Txt variant="label" tone="dim" style={{ color: theme.colors.accentGraphic }}>
          {'›'}
        </Txt>
      </View>
    </Pressable>
  );
}

export interface ToolDrawerProps {
  visible: boolean;
  onClose: () => void;
  /** Sessions blocked on an approval — the Agent row's count chip. */
  waitingCount: number;
}

/**
 * The drawer itself. Navigation happens here (not in the caller) so every
 * entry point — the dock key today, anything else tomorrow — gets identical
 * behaviour: close the sheet, then slide the panel up over the desktop.
 */
export function ToolDrawer({ visible, onClose, waitingCount }: ToolDrawerProps) {
  const theme = useTheme();
  const router = useRouter();
  const { phase } = useConnection();

  const open = (tool: ToolSpec) => {
    onClose();
    router.navigate(tool.route);
  };

  return (
    <Sheet visible={visible} onClose={onClose} testID="tool-drawer">
      <View style={{ paddingBottom: theme.space.md }}>
        {/* The wordmark, as on the computers list. The mark that used to sit
            beside it was a 40pt silhouette with a dead press handler and an
            accessibility label promising an animation that did not exist. */}
        <Txt
          heading
          style={{ ...theme.type.display, fontSize: 24, lineHeight: 29, letterSpacing: -0.9 }}
        >
          belay
        </Txt>

        {/* The app-wide link, in the app-wide words. The line here used to read
            "Connected" whenever a connection OBJECT existed, which is true
            while a link is still negotiating and still true after it drops. */}
        <ConnectionStatus
          testID="drawer-connection"
          phase={phase}
          style={{ marginTop: theme.space.xs, marginBottom: theme.space.md }}
        />

        {/* Every tool, two to a row — derived from TOOLS rather than two
            hardcoded slices that would silently drop a fifth tool. */}
        <View style={{ gap: theme.space.sm }}>
          {toolRows(TOOLS).map((row) => (
            <View key={row.map((t) => t.id).join('-')} style={{ flexDirection: 'row', gap: theme.space.sm }}>
              {row.map((tool) => (
                <ToolCard
                  key={tool.id}
                  tool={tool}
                  badge={toolBadge(tool.id, waitingCount)}
                  onPress={() => open(tool)}
                />
              ))}
              {/* An odd final row keeps its card at half width rather than
                  stretching it across the sheet. */}
              {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
            </View>
          ))}
        </View>
      </View>
    </Sheet>
  );
}
