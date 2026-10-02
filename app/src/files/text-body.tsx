// The paged monospace body of the text viewer, extracted from files-viewer.tsx
// when the viewer grew image/PDF/markdown branches. Owns its own "Show more"
// paging — a huge file must never render all at once and lock the UI — and is
// reused as the markdown viewer's source mode.
//
// The body renders on the real machine panel (docs/DESIGN.md §3.4): a file's
// contents are a window into the computer, so they sit on the true-dark
// surface in both themes, full-bleed, hairline-separated — never a border box.
// The paging footer stays on the page below the panel, where page-voice
// buttons keep their contrast.

import React, { useMemo, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption, MachinePanel } from '../ui';

/** Lines rendered per page, so a huge file cannot lock the UI. */
const VIEWER_PAGE = 1200;

export const TEXT_FONT_SIZES = { sm: 11, md: 12.5, lg: 15 } as const;

export type ViewerFont = keyof typeof TEXT_FONT_SIZES;

export interface TextBodyProps {
  readonly content: string;
  readonly wrap: boolean;
  readonly font: ViewerFont;
}

export const countLines = (content: string): number => content.split('\n').length;

// react-native-web renders numberOfLines={1} as `white-space: nowrap`, which
// collapses runs of spaces and indentation (#89). `pre` keeps the single line
// and every space.
const PRE_LINE: TextStyle | null = Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as TextStyle) : null;

// Wrap mode is a flex item, and a flex item's min-width defaults to its
// content width — with pre-wrap, the longest line — so it never wrapped on
// web (#140). minWidth 0 lets it shrink; `anywhere` breaks a long URL or JSON
// blob too, not just prose.
const WRAP_LINE: TextStyle = Platform.OS === 'web'
  ? ({ flex: 1, minWidth: 0, overflowWrap: 'anywhere' } as TextStyle)
  : { flex: 1, minWidth: 0 };

export function TextBody({ content, wrap, font }: TextBodyProps) {
  const theme = useTheme();
  const [limit, setLimit] = useState(VIEWER_PAGE);

  const lines = useMemo(() => content.split('\n').map((l) => l.replace(/\r$/, '')), [content]);
  const shown = useMemo(() => lines.slice(0, limit), [lines, limit]);

  const fontSize = TEXT_FONT_SIZES[font];
  const lineHeight = Math.round(fontSize * 1.5);
  const codeStyle = { fontFamily: theme.font.mono, fontSize, lineHeight, color: theme.colors.onMachine };
  const gutterWidth = Math.max(28, String(shown.length).length * fontSize * 0.62 + 12);

  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', padding: theme.space.sm }}>
      {!wrap ? (
        <View style={{ width: gutterWidth }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {shown.map((_, index) => (
            <Text key={index} allowFontScaling={false} style={[codeStyle, { color: theme.colors.onMachineDim, textAlign: 'right', paddingRight: 8 }]}>
              {index + 1}
            </Text>
          ))}
        </View>
      ) : null}
      {wrap ? (
        <Text selectable style={[codeStyle, WRAP_LINE]}>
          {shown.join('\n')}
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }}>
          <View>
            {shown.map((line, index) => (
              <Text key={index} selectable numberOfLines={1} ellipsizeMode="clip" style={[codeStyle, PRE_LINE]}>
                {line.length > 0 ? line : ' '}
              </Text>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );

  return (
    <ScrollView testID="viewer-body" style={{ flex: 1 }}>
      <MachinePanel>{body}</MachinePanel>
      {lines.length > shown.length ? (
        <View style={{ padding: theme.space.md, gap: theme.space.xs, alignItems: 'flex-start' }}>
          <Caption>{`${shown.length} of ${lines.length} lines shown`}</Caption>
          <Button
            testID="viewer-more"
            label="Show more"
            variant="secondary"
            size="sm"
            onPress={() => setLimit((n) => n + VIEWER_PAGE)}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}
