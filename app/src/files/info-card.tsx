// The panel shown for a long-pressed row — Finder's selection + Get Info,
// translated to touch. A phone list has no persistent selection (a tap must
// open things), so a long-press "picks up" an entry instead: its row
// highlights, and this panel surfaces the details a row is too small to show —
// most importantly the full path, with its own copy button, because copying
// the path of a specific file is the whole reason Get Info gets opened.
//
// No border box: the 2pt accentGraphic rule on top is the selection mark
// (docs/DESIGN.md §6), and a hairline closes the panel against the tab bar.

import React from 'react';
import { View } from 'react-native';
import type { FileEntry } from '../api';
import { useTheme } from '../theme';
import { Button, Label, Micro, Row, Rule, Txt } from '../ui';
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
    <View testID="files-info">
      <Rule emphasis color={theme.colors.accentGraphic} />
      <View style={{ paddingHorizontal: theme.layout.margin, paddingVertical: theme.space.sm, gap: theme.space.xs }}>
        <Row justify="space-between" gap="sm">
          <View style={{ flex: 1, gap: 2 }}>
            <Label style={{ marginBottom: 0 }}>Selected</Label>
            <Txt variant="mono" numberOfLines={1}>
              {entry.name}
            </Txt>
            <Micro>{facts}</Micro>
          </View>
          <Button testID="files-info-close" label="Done" size="sm" variant="ghost" onPress={onClose} />
        </Row>
        <Txt variant="monoSmall" tone="dim" numberOfLines={2} selectable>
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
      <Rule />
    </View>
  );
}
