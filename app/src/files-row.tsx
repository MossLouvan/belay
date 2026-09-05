// One row of the Files list — a data row inside the tab's flush Card (the
// reference's "Latest Sessions" table): name in the machine's mono voice at
// the left edge, size and date right-aligned in dim mono, a ▸ glyph marking
// directories, and a trailing ⋯ opening the details panel. The hairline
// between rows is the list's ItemSeparatorComponent, not the row's. No icon
// art and no chevron — every row is tappable, so the row itself is the
// affordance.
//
// A tap opens (folders navigate, files go to the viewer) because a phone list
// with tap-to-select would need a second gesture just to open anything. The
// details/copy-path panel is reached by the visible ⋯ — overflow is one of the
// universal five, row-trailing is its sanctioned position (§11.1) — with the
// long-press kept as the shortcut it was always meant to be: a gesture may
// never be the sole route (§11.2).

import React from 'react';
import { Pressable, View } from 'react-native';
import type { FileEntry } from './api';
import { useTheme } from './theme';
import { Txt, haptic } from './ui';
import { formatSize, formatWhen, kindOf } from './files-format';

/** Fixed width of the ▸ column so names align whether or not one is present. */
const MARKER_WIDTH = 18;

export interface FileRowProps {
  entry: FileEntry;
  now: number;
  selected: boolean;
  onPress: (entry: FileEntry) => void;
  onLongPress: (entry: FileEntry) => void;
  /** Opens the entry's details panel — the ⋯'s job and the long-press's. */
  onInfo: (entry: FileEntry) => void;
}

export const FileRow = React.memo(function FileRow({ entry, now, selected, onPress, onLongPress, onInfo }: FileRowProps) {
  const theme = useTheme();
  const when = formatWhen(entry.mtime, now);
  // Size and date right-aligned; Kind stays in the sort header, the
  // accessibility label and the details panel, where it earns its space.
  const trailing = [entry.dir ? '' : formatSize(entry.size), when].filter(Boolean).join(' · ');
  const spoken = [kindOf(entry), entry.dir ? '' : formatSize(entry.size), when].filter(Boolean).join(', ');

  return (
    /* The ⋯ is a sibling of the row's Pressable, never a child: on web a
       nested pressable renders <button> inside <button>, which React DOM
       rejects loudly enough to cover the page (see ui/controls.tsx), and
       nesting would also make the row's own onPress fire under the ⋯. The
       selection band paints on this wrapper so it spans both. */
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'stretch',
        backgroundColor: selected ? theme.colors.accentSoft : 'transparent',
      }}
    >
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
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
          minHeight: theme.layout.rowHeight,
          paddingVertical: theme.space.xs,
          paddingLeft: theme.space.md,
          backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
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
      <Pressable
        testID={`entry-info-${entry.name}`}
        accessibilityRole="button"
        accessibilityLabel={`Details for ${entry.name}`}
        accessibilityHint="Shows kind, size and the full path, with copy"
        onPress={() => {
          haptic('light');
          onInfo(entry);
        }}
        style={({ pressed }) => ({
          width: theme.layout.minTouch,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? theme.motion.pressOpacity : 1,
        })}
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Txt variant="label" tone="faint">
            ⋯
          </Txt>
        </View>
      </Pressable>
    </View>
  );
});
