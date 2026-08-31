// Rendered markdown: the block list from markdown.ts mapped onto plain <Text>
// and <View>. Deliberately restrained — type scale, hairline rules and the
// existing palette, no card chrome — so the coming editorial restyle only has
// to touch tokens, not structure. Links are shown styled but are not tappable:
// a README's links point at the host's filesystem or the wider web, and a
// read-only file viewer should not be a springboard into either.

import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { useTheme } from '../theme';
import { parseMarkdown } from './markdown';
import type { InlineSpan, MdBlock } from './markdown';

/** Heading sizes by level; anything deeper than h4 reads as bold body text. */
const HEADING_SIZES: readonly number[] = [24, 20, 17, 15];

const BODY_SIZE = 15;
const CODE_SIZE = 12.5;
const LINE_RATIO = 1.5;
const QUOTE_BAR_WIDTH = 2;

interface Palette {
  readonly theme: ReturnType<typeof useTheme>;
}

function SpanText({ spans, base }: { spans: readonly InlineSpan[]; base: TextStyle } & Record<never, never>) {
  const theme = useTheme();
  return (
    <Text selectable style={base}>
      {spans.map((span, index) => (
        <Text
          key={index}
          style={[
            span.bold ? { fontWeight: '700' } : null,
            span.italic ? { fontStyle: 'italic' } : null,
            span.code
              ? {
                  fontFamily: theme.font.mono,
                  fontSize: (base.fontSize ?? BODY_SIZE) - 2,
                  color: theme.colors.textDim,
                  backgroundColor: theme.colors.surfaceAlt,
                }
              : null,
            span.link ? { color: theme.colors.accent, textDecorationLine: 'underline' } : null,
          ]}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

function Block({ block, theme }: { block: MdBlock } & Palette) {
  const body: TextStyle = {
    fontSize: BODY_SIZE,
    lineHeight: Math.round(BODY_SIZE * LINE_RATIO),
    color: theme.colors.text,
  };

  switch (block.kind) {
    case 'heading': {
      const fontSize = HEADING_SIZES[Math.min(block.level, HEADING_SIZES.length) - 1];
      return (
        <SpanText
          spans={block.spans}
          base={{
            fontSize,
            lineHeight: Math.round(fontSize * 1.3),
            fontWeight: '700',
            color: theme.colors.text,
            marginTop: block.level <= 2 ? theme.space.sm : theme.space.xs,
          }}
        />
      );
    }
    case 'paragraph':
      return <SpanText spans={block.spans} base={body} />;
    case 'code':
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          style={{
            backgroundColor: theme.isDark ? theme.colors.black : theme.colors.surfaceAlt,
            borderWidth: theme.layout.hairline,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.sm,
          }}
          contentContainerStyle={{ padding: theme.space.sm }}
        >
          <Text selectable style={{ fontFamily: theme.font.mono, fontSize: CODE_SIZE, lineHeight: Math.round(CODE_SIZE * LINE_RATIO), color: theme.colors.text }}>
            {block.text.length > 0 ? block.text : ' '}
          </Text>
        </ScrollView>
      );
    case 'quote':
      return (
        <View
          style={{
            borderLeftWidth: QUOTE_BAR_WIDTH,
            borderLeftColor: theme.colors.borderStrong,
            paddingLeft: theme.space.sm,
          }}
        >
          <SpanText spans={block.spans} base={{ ...body, color: theme.colors.textDim, fontStyle: 'italic' }} />
        </View>
      );
    case 'item':
      return (
        <View style={{ flexDirection: 'row', paddingLeft: theme.space.md * block.depth }}>
          <Text style={[body, { color: theme.colors.textDim, minWidth: 22 }]}>
            {block.ordered ? block.marker : '•'}
          </Text>
          <View style={{ flex: 1 }}>
            <SpanText spans={block.spans} base={body} />
          </View>
        </View>
      );
    case 'rule':
      return <View style={{ height: theme.layout.hairline, backgroundColor: theme.colors.border, marginVertical: theme.space.xs }} />;
    default:
      return null;
  }
}

export function MarkdownView({ content }: { content: string }) {
  const theme = useTheme();
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return (
    <ScrollView
      testID="viewer-markdown"
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm,
        gap: theme.space.sm,
        maxWidth: theme.layout.contentMaxWidth,
        width: '100%',
        alignSelf: 'center',
      }}
    >
      {blocks.map((block, index) => (
        <Block key={index} block={block} theme={theme} />
      ))}
    </ScrollView>
  );
}
