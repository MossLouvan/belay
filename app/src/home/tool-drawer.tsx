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
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { font, useTheme } from '../theme';
import { Caption, Divider, Label, Sheet, Txt, haptic } from '../ui';
import { TOOLS, toolBadge } from './tools';
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
      <Text
        allowFontScaling={false}
        style={{ color: theme.colors.onAccent, fontFamily: font.mono, fontSize: 10 }}
      >
        {String(count)}
      </Text>
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
  const { connection } = useConnection();

  const open = (tool: ToolSpec) => {
    onClose();
    router.navigate(tool.route);
  };

  // For latency, we would need to get ping info. For now, just show "Connected" without latency
  // In a full implementation, this would come from connection.pingMs or similar
  const latencyText = connection ? 'Connected' : 'Not connected';

  return (
    <Sheet visible={visible} onClose={onClose} testID="tool-drawer">
      <View style={{ paddingBottom: theme.space.md }}>
        {/* Beluga + Belay header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginBottom: theme.space.xs }}>
          <Image
            source={require('../../assets/beluga-mascot.jpg')}
            style={{ width: 40, height: 40, borderRadius: 20 }}
            resizeMode="cover"
          />
          <Txt variant="title" style={{ fontSize: 24 }}>Belay</Txt>
        </View>

        {/* Connected status pill */}
        <View
          style={{
            alignSelf: 'flex-start',
            paddingHorizontal: theme.space.sm,
            paddingVertical: theme.space.xxs,
            borderRadius: theme.radius.xs,
            backgroundColor: theme.colors.surfaceAlt,
            marginBottom: theme.space.sm,
          }}
        >
          <Label tone="dim">{latencyText}</Label>
        </View>

        {/* Thin blue rope accent */}
        <View
          style={{
            height: 2,
            backgroundColor: theme.colors.accentGraphic,
            borderRadius: 1,
            marginBottom: theme.space.md,
          }}
        />

        {/* 2x2 grid of tools */}
        <View style={{ gap: theme.space.sm }}>
          {/* First row: Host and Terminal */}
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            {TOOLS.slice(0, 2).map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                badge={toolBadge(tool.id, waitingCount)}
                onPress={() => open(tool)}
              />
            ))}
          </View>
          {/* Second row: Files and Agent (System is now 4th, so we show Files and Agent) */}
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            {TOOLS.slice(2, 4).map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                badge={toolBadge(tool.id, waitingCount)}
                onPress={() => open(tool)}
              />
            ))}
          </View>
        </View>

        <Caption style={{ marginTop: theme.space.md, textAlign: 'center' }}>
          Tap a tool to launch
        </Caption>
      </View>
    </Sheet>
  );
}
