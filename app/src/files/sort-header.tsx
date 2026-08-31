// The column header over the file list — Finder's list-view header shrunk to a
// phone. Real columns do not survive a 390pt screen (four of them leave the
// name ~40pt), so the header keeps Finder's *behaviour* instead of its grid:
// tap a column to sort by it, tap it again to flip the direction, with the
// active column carrying the ▲/▼ caret. The values themselves live inside each
// row rather than being aligned into columns.

import React from 'react';
import { Pressable, Text } from 'react-native';
import { useTheme } from '../theme';
import { Row, Txt, haptic } from '../ui';
import type { SortKey } from '../files-format';
import { defaultDescending } from '../files-format';

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind' },
  { key: 'size', label: 'Size' },
  { key: 'date', label: 'Date' },
];

export interface SortHeaderProps {
  sortKey: SortKey;
  descending: boolean;
  onChange: (key: SortKey, descending: boolean) => void;
}

export function SortHeader({ sortKey, descending, onChange }: SortHeaderProps) {
  const theme = useTheme();
  return (
    <Row
      gap="none"
      style={{
        marginHorizontal: theme.space.sm,
        marginBottom: theme.space.xs,
        borderRadius: theme.radius.md,
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
      }}
    >
      {COLUMNS.map((column) => {
        const active = column.key === sortKey;
        return (
          <Pressable
            key={column.key}
            testID={`files-sort-${column.key}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Sort by ${column.label.toLowerCase()}`}
            accessibilityHint={active ? 'Reverses the current order' : undefined}
            onPress={() => {
              haptic('light');
              // Finder's rule: a repeat tap flips the order, a fresh column
              // starts in the direction people expect of it (see sort.ts).
              onChange(column.key, active ? !descending : defaultDescending(column.key));
            }}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 3,
              minHeight: 34,
              backgroundColor: pressed || active ? theme.colors.surfaceAlt : 'transparent',
            })}
          >
            <Txt
              variant="caption"
              color={active ? theme.colors.text : theme.colors.textDim}
              style={{ fontWeight: active ? '700' : '500' }}
            >
              {column.label}
            </Txt>
            {active ? (
              <Text allowFontScaling={false} style={{ color: theme.colors.onAccentSoft, fontSize: 8 }}>
                {descending ? '▼' : '▲'}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </Row>
  );
}
