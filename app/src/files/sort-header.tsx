// The column header over the file list — Finder's list-view header shrunk to a
// phone. Real columns do not survive a 390pt screen (four of them leave the
// name ~40pt), so the header keeps Finder's *behaviour* instead of its grid:
// tap a column to sort by it, tap it again to flip the direction, with the
// active column carrying the ▲/▼ caret. The values themselves live inside each
// row rather than being aligned into columns.
//
// Card treatment: this header is the top row of the tab's flush listing
// Card — mono micro-labels on resting granite tracks, closed by the card's
// own hairline divider. The active column is the screen's ONE blue accent
// (label and track) and carries the ▲/▼ caret; every other column rests
// dim on `trackRest` (§3.3). Name sits at the card's left padding where the
// row names align; the value columns gather at the right where the row
// values align.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Divider, Row, TrackLabel } from '../ui';
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
  return (
    <TrackLabel
      testID={`files-sort-${column.key}`}
      label={`${column.label}${active ? (descending ? ' ▼' : ' ▲') : ''}`}
      accessibilityLabel={`Sort by ${column.label.toLowerCase()}`}
      accessibilityHint={active ? 'Reverses the current order' : undefined}
      active={active}
      onPress={() =>
        // Finder's rule: a repeat tap flips the order, a fresh column
        // starts in the direction people expect of it (see sort.ts).
        onChange(column.key, active ? !descending : defaultDescending(column.key))
      }
    />
  );
}

export function SortHeader({ sortKey, descending, onChange }: SortHeaderProps) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.space.md, paddingTop: theme.space.xxs }}>
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
      <Divider inset={-theme.space.md} />
    </View>
  );
}
