// The paged monospace body of the text viewer, extracted from files-viewer.tsx
// when the viewer grew image/PDF/markdown branches. Owns its own "Show more"
// paging — a huge file must never render all at once and lock the UI — and is
// reused as the markdown viewer's source mode.

import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption } from '../ui';

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

export function TextBody({ content, wrap, font }: TextBodyProps) {
  const theme = useTheme();
  const [limit, setLimit] = useState(VIEWER_PAGE);

  const lines = useMemo(() => content.split('\n').map((l) => l.replace(/\r$/, '')), [content]);
  const shown = useMemo(() => lines.slice(0, limit), [lines, limit]);

  const fontSize = TEXT_FONT_SIZES[font];
  const lineHeight = Math.round(fontSize * 1.5);
  const canvas = theme.isDark ? theme.colors.black : theme.colors.surface;
  const codeStyle = { fontFamily: theme.font.mono, fontSize, lineHeight, color: theme.colors.text };
  const gutterWidth = Math.max(28, String(shown.length).length * fontSize * 0.62 + 12);

  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', padding: theme.space.sm }}>
      {!wrap ? (
        <View style={{ width: gutterWidth }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {shown.map((_, index) => (
            <Text key={index} allowFontScaling={false} style={[codeStyle, { color: theme.colors.textFaint, textAlign: 'right', paddingRight: 8 }]}>
              {index + 1}
            </Text>
          ))}
        </View>
      ) : null}
      {wrap ? (
        <Text selectable style={[codeStyle, { flex: 1 }]}>
          {shown.join('\n')}
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }}>
          <View>
            {shown.map((line, index) => (
              <Text key={index} selectable numberOfLines={1} style={codeStyle}>
                {line.length > 0 ? line : ' '}
              </Text>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );

  return (
    <ScrollView
      testID="viewer-body"
      style={{
        flex: 1,
        marginHorizontal: theme.space.sm,
        backgroundColor: canvas,
        borderRadius: theme.radius.md,
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.border,
      }}
    >
      {body}
      {lines.length > shown.length ? (
        <View style={{ padding: theme.space.md, gap: theme.space.xs, alignItems: 'center' }}>
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
