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
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { font, useTheme } from '../theme';
import { Caption, Divider, Sheet, Txt, haptic } from '../ui';
import { TOOLS, toolBadge } from './tools';
import type { ToolSpec } from './tools';
import { ToolGlyph } from './tool-glyphs';

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
      <Text
        allowFontScaling={false}
        style={{ color: theme.colors.onAccent, fontFamily: font.mono, fontSize: 10 }}
      >
        {String(count)}
      </Text>
    </View>
  );
}

function ToolRow({ tool, badge, onPress }: { tool: ToolSpec; badge: number | null; onPress: () => void }) {
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.sm,
        minHeight: 56,
        paddingVertical: theme.space.xs,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <ToolGlyph id={tool.id} color={theme.colors.text} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xs }}>
          <Txt variant="bodyStrong">{tool.title}</Txt>
          {badge !== null ? <CountChip count={badge} /> : null}
        </View>
        <Caption>{tool.description}</Caption>
      </View>
      {/* Quiet forward mark: these rows go somewhere. */}
      <Txt variant="label" tone="dim">
        {'›'}
      </Txt>
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

  const open = (tool: ToolSpec) => {
    onClose();
    router.navigate(tool.route);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Tools" testID="tool-drawer">
      <ScrollView style={{ maxHeight: 400 }}>
        {TOOLS.map((tool, index) => (
          <View key={tool.id}>
            {index > 0 ? <Divider /> : null}
            <ToolRow tool={tool} badge={toolBadge(tool.id, waitingCount)} onPress={() => open(tool)} />
          </View>
        ))}
        <Caption style={{ marginTop: theme.space.sm }}>
          Every tool opens over the desktop — close it and you are right back here.
        </Caption>
      </ScrollView>
    </Sheet>
  );
}
