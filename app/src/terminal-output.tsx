// The terminal transcript: the measuring probe, the virtualised line list, the
// "nothing yet" hint and the jump-to-latest affordance.
//
// The transcript is a machine panel (docs/DESIGN.md §3.4): true-dark in both
// themes, full-bleed, no border box — the screen draws the separating
// hairlines above and below it. Ink on it is the `onMachine` pair, never the
// page's text colours, which are tuned for paper.

import React, { useCallback } from 'react';
import { FlatList, Platform, Pressable, Text, View } from 'react-native';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useTheme } from './theme';
import { Txt } from './ui';
import type { TermLine } from './terminal-ansi';
import { TermRow } from './terminal-row';
import { PROBE_TEXT } from './terminal-geometry';

export interface TerminalOutputProps {
  listRef: React.RefObject<FlatList<TermLine> | null>;
  lines: readonly TermLine[];
  ramp: readonly string[];
  /** Redraw key for anything the rows read but do not receive as props. */
  redraw: string;
  fontSize: number;
  lineHeight: number;
  padding: number;
  /** Background of the transcript panel; the rows' inverse-video colour too. */
  canvas: string;
  /** Shown over an empty transcript. */
  placeholder: string;
  blank: boolean;
  following: boolean;
  onFollow: () => void;
  onRowWidth: (event: LayoutChangeEvent) => void;
  onProbeWidth: (event: LayoutChangeEvent) => void;
  onOutputLayout: (event: LayoutChangeEvent) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: () => void;
}

export function TerminalOutput({
  listRef,
  lines,
  ramp,
  redraw,
  fontSize,
  lineHeight,
  padding,
  canvas,
  placeholder,
  blank,
  following,
  onFollow,
  onRowWidth,
  onProbeWidth,
  onOutputLayout,
  onScroll,
  onContentSizeChange,
}: TerminalOutputProps) {
  const theme = useTheme();

  // Index keys are deliberate. A line's content is replaced far more often than
  // the list is reordered, and `feed` returns a *new* frozen object for every
  // line it touches — so a content-derived key would unmount and remount a row
  // on ordinary output, while an index key updates the props of a row that is
  // already mounted. A scrollback trim shifts every index by the same amount,
  // which is likewise a prop update rather than a remount.
  const keyExtractor = useCallback((_: TermLine, index: number) => String(index), []);

  const getItemLayout = useCallback(
    (_: ArrayLike<TermLine> | null | undefined, index: number) => ({
      length: lineHeight,
      offset: lineHeight * index,
      index,
    }),
    [lineHeight]
  );

  const renderItem = useCallback(
    ({ item }: { item: TermLine }) => (
      <TermRow
        line={item}
        ramp={ramp}
        fg={theme.colors.onMachine}
        bg={canvas}
        fontFamily={theme.font.mono}
        fontSize={fontSize}
        lineHeight={lineHeight}
      />
    ),
    [canvas, fontSize, lineHeight, ramp, theme.colors.onMachine, theme.font.mono]
  );

  return (
    <View style={{ flex: 1 }}>
      <Text
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        allowFontScaling={false}
        onLayout={onProbeWidth}
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          opacity: 0,
          fontFamily: theme.font.mono,
          fontSize,
          lineHeight,
        }}
      >
        {PROBE_TEXT}
      </Text>
      <FlatList
        ref={listRef}
        testID="term-output"
        data={lines}
        extraData={redraw}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        onLayout={onOutputLayout}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSizeChange}
        initialNumToRender={40}
        windowSize={9}
        removeClippedSubviews={Platform.OS !== 'web'}
        keyboardShouldPersistTaps="handled"
        // Dragging the transcript pulls the keyboard away with the finger —
        // the natural "scroll up to re-read" gesture doubles as the exit the
        // tap-to-blur never advertised (docs/DESIGN.md §11.2).
        keyboardDismissMode="interactive"
        ListHeaderComponent={<View onLayout={onRowWidth} style={{ height: 0 }} />}
        contentContainerStyle={{ padding }}
        style={{ flex: 1, backgroundColor: canvas }}
      />

      {/* The buffer always holds one empty line, so FlatList's own empty state
          would never fire — this overlay is the honest "nothing yet" hint. */}
      {blank ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: padding * 2, left: padding * 2 }}>
          <Txt variant="mono" tone="onMachineDim" testID="term-placeholder">
            {placeholder}
          </Txt>
        </View>
      ) : null}

      {!following ? (
        <Pressable
          testID="term-follow"
          accessibilityRole="button"
          accessibilityLabel="Jump to the latest output"
          onPress={onFollow}
          style={({ pressed }) => ({
            position: 'absolute',
            right: theme.space.sm,
            bottom: theme.space.sm,
            paddingHorizontal: theme.space.md,
            minHeight: theme.layout.minTouch,
            justifyContent: 'center',
            borderRadius: theme.radius.xs,
            backgroundColor: theme.colors.accent,
            opacity: pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <Txt variant="label" color={theme.colors.onAccent}>
            ↓ Latest
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}
