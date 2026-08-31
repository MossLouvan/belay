// One row of the Files list. Ledger anatomy (docs/DESIGN.md §7.2): name in the
// machine's mono voice at the left edge, size and date right-aligned in dim
// mono, a ▸ glyph marking directories, and a full-bleed hairline underneath.
// No icon art and no chevron — every row in this list is tappable, so the row
// itself is the affordance.
//
// A tap opens (folders navigate, files go to the viewer) because a phone list
// with tap-to-select would need a second gesture just to open anything; the
// long-press carries Finder's "select" instead, highlighting the row and
// letting the screen show its info panel.

import React from 'react';
import { Pressable, View } from 'react-native';
import type { FileEntry } from './api';
import { useTheme } from './theme';
import { Rule, Txt, haptic } from './ui';
import { formatSize, formatWhen, kindOf } from './files-format';

/** Fixed width of the ▸ column so names align whether or not one is present. */
const MARKER_WIDTH = 18;

export interface FileRowProps {
  entry: FileEntry;
  now: number;
  selected: boolean;
  onPress: (entry: FileEntry) => void;
  onLongPress: (entry: FileEntry) => void;
}

export const FileRow = React.memo(function FileRow({ entry, now, selected, onPress, onLongPress }: FileRowProps) {
  const theme = useTheme();
  const when = formatWhen(entry.mtime, now);
  // Size and date right-aligned; Kind stays in the sort header, the
  // accessibility label and the long-press details, where it earns its space.
  const trailing = [entry.dir ? '' : formatSize(entry.size), when].filter(Boolean).join(' · ');
  const spoken = [kindOf(entry), entry.dir ? '' : formatSize(entry.size), when].filter(Boolean).join(', ');

  return (
    <View>
      <Pressable
        testID={`entry-${entry.name}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${entry.dir ? 'Folder' : 'File'} ${entry.name}${spoken ? `, ${spoken}` : ''}`}
        accessibilityHint="Long press for details and copy path"
        onPress={() => {
          haptic('light');
          onPress(entry);
        }}
        onLongPress={() => {
          haptic('medium');
          onLongPress(entry);
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
          minHeight: theme.layout.rowHeight,
          paddingVertical: theme.space.xs,
          marginHorizontal: -theme.layout.margin,
          paddingHorizontal: theme.layout.margin,
          backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfaceAlt : 'transparent',
        })}
      >
        <View style={{ width: MARKER_WIDTH }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {entry.dir ? (
            <Txt variant="mono" tone="dim">
              ▸
            </Txt>
          ) : null}
        </View>
        <Txt variant="mono" numberOfLines={1} style={{ flex: 1 }}>
          {entry.name}
        </Txt>
        {trailing ? (
          <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ textAlign: 'right' }}>
            {trailing}
          </Txt>
        ) : null}
      </Pressable>
      <Rule bleed={theme.layout.margin} />
    </View>
  );
});
