// The column header over the file list — Finder's list-view header shrunk to a
// phone. Real columns do not survive a 390pt screen (four of them leave the
// name ~40pt), so the header keeps Finder's *behaviour* instead of its grid:
// tap a column to sort by it, tap it again to flip the direction, with the
// active column carrying the ▲/▼ caret. The values themselves live inside each
// row rather than being aligned into columns.
//
// Ledger treatment: mono micro-labels, the active sort in accent, and a
// hairline rule closing the header — no box, no fill. Name sits at the left
// margin where the row names align; the value columns gather at the right
// margin where the row values align.

import React from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../theme';
import { Label, Rule, Row, haptic } from '../ui';
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

function Column({
  column,
  active,
  descending,
  onChange,
}: {
  column: (typeof COLUMNS)[number];
  active: boolean;
  descending: boolean;
  onChange: SortHeaderProps['onChange'];
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`files-sort-${column.key}`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Sort by ${column.label.toLowerCase()}`}
      accessibilityHint={active ? 'Reverses the current order' : undefined}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => {
        haptic('light');
        // Finder's rule: a repeat tap flips the order, a fresh column
        // starts in the direction people expect of it (see sort.ts).
        onChange(column.key, active ? !descending : defaultDescending(column.key));
      }}
      style={({ pressed }) => ({
        minHeight: theme.space.xl,
        justifyContent: 'center',
        opacity: pressed ? theme.motion.pressOpacity : 1,
      })}
    >
      <Label tone={active ? 'accent' : 'dim'} style={{ marginBottom: 0 }}>
        {`${column.label}${active ? (descending ? ' ▼' : ' ▲') : ''}`}
      </Label>
    </Pressable>
  );
}

export function SortHeader({ sortKey, descending, onChange }: SortHeaderProps) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.layout.margin }}>
      <Row justify="space-between" gap="sm">
        <Column column={COLUMNS[0]} active={sortKey === 'name'} descending={descending} onChange={onChange} />
        <Row gap="md">
          {COLUMNS.slice(1).map((column) => (
            <Column
              key={column.key}
              column={column}
              active={column.key === sortKey}
              descending={descending}
              onChange={onChange}
            />
          ))}
        </Row>
      </Row>
      <Rule bleed={theme.layout.margin} />
    </View>
  );
}
