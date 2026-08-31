// One row of the Files list, and the little type glyph in front of it.
//
// A tap opens (folders navigate, files go to the viewer) because a phone list
// with tap-to-select would need a second gesture just to open anything; the
// long-press carries Finder's "select" instead, highlighting the row and
// letting the screen show its info card.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FileEntry } from './api';
import { Palette, useTheme } from './theme';
import { Caption, Txt, haptic } from './ui';
import { Category, categoryOf, extensionOf, formatSize, formatWhen, kindOf } from './files-format';

const categoryColor = (category: Category, colors: Palette): string => {
  const map: Record<Category, string> = {
    folder: colors.accent,
    code: colors.accent,
    text: colors.good,
    image: colors.warn,
    media: colors.warn,
    archive: colors.textDim,
    binary: colors.bad,
    doc: colors.bad,
    other: colors.textFaint,
  };
  return map[category];
};

interface FileGlyphProps {
  entry: FileEntry;
  tint: string;
}

function FileGlyph({ entry, tint }: FileGlyphProps) {
  const theme = useTheme();
  const extension = extensionOf(entry.name).slice(0, 4);
  if (entry.dir) {
    return (
      <View style={{ width: 30, height: 26, justifyContent: 'flex-end' }}>
        <View style={{ position: 'absolute', top: 0, left: 1, width: 12, height: 5, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: tint }} />
        <View style={{ width: 26, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: tint, backgroundColor: theme.colors.accentSoft }} />
      </View>
    );
  }
  return (
    <View
      style={{
        width: 30,
        height: 26,
        borderRadius: 5,
        borderWidth: 1.5,
        borderColor: tint,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceAlt,
      }}
    >
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={{ color: tint, fontSize: extension.length > 3 ? 7 : 8.5, fontWeight: '800', letterSpacing: 0.2 }}
      >
        {extension ? extension.toUpperCase() : '•'}
      </Text>
    </View>
  );
}

export interface FileRowProps {
  entry: FileEntry;
  now: number;
  selected: boolean;
  onPress: (entry: FileEntry) => void;
  onLongPress: (entry: FileEntry) => void;
}

export const FileRow = React.memo(function FileRow({ entry, now, selected, onPress, onLongPress }: FileRowProps) {
  const theme = useTheme();
  const tint = categoryColor(categoryOf(entry), theme.colors);
  const when = formatWhen(entry.mtime, now);
  // Finder's Kind, Size and Date columns, collapsed into one caption line —
  // the columns themselves do not fit next to a name on a phone.
  const detail = [kindOf(entry), entry.dir ? '' : formatSize(entry.size), when].filter(Boolean).join(' · ');

  return (
    <Pressable
      testID={`entry-${entry.name}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${entry.dir ? 'Folder' : 'File'} ${entry.name}${detail ? `, ${detail}` : ''}`}
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
        minHeight: theme.layout.minTouch + 8,
        paddingVertical: theme.space.xs,
        paddingHorizontal: theme.space.sm,
        borderRadius: theme.radius.md,
        backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfaceAlt : 'transparent',
      })}
    >
      <FileGlyph entry={entry} tint={tint} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="bodyStrong" numberOfLines={1}>
          {entry.name}
        </Txt>
        {detail ? <Caption numberOfLines={1}>{detail}</Caption> : null}
      </View>
      {entry.dir ? (
        <Text allowFontScaling={false} style={{ color: theme.colors.textFaint, fontSize: 18, marginRight: 2 }}>
          ›
        </Text>
      ) : null}
    </Pressable>
  );
});
