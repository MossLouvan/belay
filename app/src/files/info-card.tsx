// The card shown for a long-pressed row — Finder's selection + Get Info,
// translated to touch. A phone list has no persistent selection (a tap must
// open things), so a long-press "picks up" an entry instead: its row
// highlights, and this card surfaces the details a row is too small to show —
// most importantly the full path, with its own copy button, because copying
// the path of a specific file is the whole reason Get Info gets opened.

import React from 'react';
import { View } from 'react-native';
import type { FileEntry } from '../api';
import { useTheme } from '../theme';
import { Button, Caption, Row, Txt } from '../ui';
import { formatSize, formatWhen, kindOf } from '../files-format';
import { copyText } from './clipboard';

export interface InfoCardProps {
  entry: FileEntry;
  now: number;
  onClose: () => void;
}

export function InfoCard({ entry, now, onClose }: InfoCardProps) {
  const theme = useTheme();
  const when = formatWhen(entry.mtime, now);
  const facts = [kindOf(entry), entry.dir ? '' : formatSize(entry.size), when]
    .filter(Boolean)
    .join(' · ');

  return (
    <View
      testID="files-info"
      style={{
        marginHorizontal: theme.space.sm,
        marginBottom: theme.space.xs,
        padding: theme.space.sm,
        gap: theme.space.xs,
        borderRadius: theme.radius.md,
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface,
      }}
    >
      <Row justify="space-between" gap="sm">
        <View style={{ flex: 1 }}>
          <Txt variant="bodyStrong" numberOfLines={1}>
            {entry.name}
          </Txt>
          <Caption numberOfLines={1}>{facts}</Caption>
        </View>
        <Button testID="files-info-close" label="Done" size="sm" variant="ghost" onPress={onClose} />
      </Row>
      <Txt variant="monoSmall" color={theme.colors.textDim} numberOfLines={2} selectable>
        {entry.path}
      </Txt>
      <Button
        testID="files-info-copy"
        label="Copy path"
        size="sm"
        variant="secondary"
        onPress={() => copyText(entry.path)}
      />
    </View>
  );
}
