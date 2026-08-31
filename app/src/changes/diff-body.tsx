// The full diff, rendered on the machine panel — the same true-dark "window
// into the computer" the terminal and file viewer use (docs/DESIGN.md §3.4).
// Added lines take the good colour, removed lines the bad, position markers
// dim; everything else stays the panel's plain mono. Colour is the entire
// grammar, so the screen never needs to teach diff syntax.
//
// Paged like the file viewer's TextBody: a capped diff can still be five
// thousand lines, and rendering them all at once locks the UI.

import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useTheme } from '../theme';
import { Button, Caption, MachinePanel } from '../ui';
import { splitDiff } from './diff-format';
import type { DiffLine } from './diff-format';

/** Diff lines rendered per page. */
const DIFF_PAGE = 800;

const FONT_SIZE = 12.5;

interface RenderLine extends DiffLine {
  /** A section-header pseudo-line carrying the file's path. */
  readonly header?: boolean;
}

export interface DiffBodyProps {
  readonly diff: string;
  /** True when the host cut the diff at its cap. */
  readonly truncated: boolean;
  /** Page padding, so the panel can bleed edge-to-edge. */
  readonly bleed: number;
}

export function DiffBody({ diff, truncated, bleed }: DiffBodyProps) {
  const theme = useTheme();
  const [limit, setLimit] = useState(DIFF_PAGE);

  // Flatten sections into one line stream with header rows, so paging cuts
  // across file boundaries instead of rendering whole files at once.
  const lines = useMemo<RenderLine[]>(() => {
    const flat: RenderLine[] = [];
    for (const section of splitDiff(diff)) {
      if (section.path) flat.push({ kind: 'meta', text: section.path, header: true });
      flat.push(...section.lines);
    }
    return flat;
  }, [diff]);

  const shown = lines.slice(0, limit);
  const lineHeight = Math.round(FONT_SIZE * 1.5);

  const inkFor = (line: RenderLine): string => {
    if (line.kind === 'add') return theme.colors.good;
    if (line.kind === 'remove') return theme.colors.bad;
    if (line.kind === 'hunk' || line.kind === 'meta') return theme.colors.onMachineDim;
    return theme.colors.onMachine;
  };

  return (
    <View>
      <MachinePanel bleed={bleed}>
        <ScrollView horizontal showsHorizontalScrollIndicator style={{ padding: theme.space.sm }}>
          <View>
            {shown.map((line, index) => (
              <Text
                key={index}
                selectable
                allowFontScaling={false}
                style={{
                  fontFamily: theme.font.mono,
                  fontSize: FONT_SIZE,
                  lineHeight,
                  color: inkFor(line),
                  ...(line.header ? { marginTop: index === 0 ? 0 : lineHeight, fontWeight: '700' as const } : {}),
                }}
              >
                {line.header ? `── ${line.text}` : line.text || ' '}
              </Text>
            ))}
          </View>
        </ScrollView>
      </MachinePanel>
      {lines.length > limit ? (
        <View style={{ marginTop: theme.space.sm, gap: theme.space.xs }}>
          <Button
            label={`Show more (${lines.length - limit} lines left)`}
            variant="secondary"
            size="sm"
            onPress={() => setLimit((l) => l + DIFF_PAGE)}
          />
        </View>
      ) : null}
      {truncated ? (
        <Caption style={{ marginTop: theme.space.xs }}>
          The change is bigger than fits here — this is the first part of it.
        </Caption>
      ) : null}
    </View>
  );
}
