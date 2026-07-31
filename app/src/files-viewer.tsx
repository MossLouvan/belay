// The read-only text viewer the Files screen pushes over itself when a file is
// opened. Paged rather than all-at-once, so a large file cannot lock the UI.

import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';
import { Banner, Button, Caption, EmptyState, Row, SegmentedControl, Txt } from './ui';
import { formatSize, looksBinary } from './files-format';

/** The host truncates a read at this size and sets `truncated`. */
const READ_LIMIT_LABEL = '512 KB';
/** Lines rendered per page, so a huge file cannot lock the UI. */
const VIEWER_PAGE = 1200;
const FONT_SIZES = { sm: 11, md: 12.5, lg: 15 } as const;

type ViewerFont = keyof typeof FONT_SIZES;

export interface OpenFile {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly size: number;
}

export interface FileViewerProps {
  file: OpenFile;
  onClose: () => void;
}

export function FileViewer({ file, onClose }: FileViewerProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [wrap, setWrap] = useState(false);
  const [font, setFont] = useState<ViewerFont>('md');
  const [limit, setLimit] = useState(VIEWER_PAGE);
  const [forceText, setForceText] = useState(false);

  const binary = useMemo(() => looksBinary(file.content), [file.content]);
  const lines = useMemo(() => file.content.split('\n').map((l) => l.replace(/\r$/, '')), [file.content]);
  const shown = useMemo(() => lines.slice(0, limit), [lines, limit]);

  const fontSize = FONT_SIZES[font];
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
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      <Row justify="space-between" gap="sm" style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.xs }}>
        <View style={{ flex: 1 }}>
          <Txt variant="subheading" numberOfLines={1} heading>
            {file.name}
          </Txt>
          <Caption numberOfLines={1}>{`${formatSize(file.size)} · ${lines.length} lines`}</Caption>
        </View>
        <Button testID="viewer-close" label="Close" onPress={onClose} size="sm" variant="secondary" />
      </Row>

      <Row gap="sm" style={{ paddingHorizontal: theme.space.sm, paddingBottom: theme.space.xs }}>
        <SegmentedControl
          testID="viewer-font"
          accessibilityLabel="Text size"
          options={[{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }]}
          value={font}
          onChange={setFont}
          style={{ width: 108 }}
        />
        <SegmentedControl
          testID="viewer-wrap"
          accessibilityLabel="Line wrapping"
          options={[{ value: 'off', label: 'No wrap' }, { value: 'on', label: 'Wrap' }]}
          value={wrap ? 'on' : 'off'}
          onChange={(next) => setWrap(next === 'on')}
          style={{ flex: 1 }}
        />
      </Row>

      {file.truncated ? (
        <Banner
          testID="viewer-truncated"
          status="warn"
          title="Showing the start of this file"
          message={`The host stops reading at ${READ_LIMIT_LABEL}, so everything past that point is not here.`}
          style={{ marginHorizontal: theme.space.sm, marginBottom: theme.space.xs }}
        />
      ) : null}

      {binary && !forceText ? (
        <EmptyState
          testID="viewer-binary"
          title="This looks like a binary file"
          message="Rendering it as text would produce nothing but mojibake. There is no preview for this format."
          action={{ label: 'Show raw text anyway', onPress: () => setForceText(true) }}
        />
      ) : (
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
      )}
      <View style={{ height: theme.space.sm }} />
    </View>
  );
}
