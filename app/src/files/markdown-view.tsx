// Rendered markdown: the block list from markdown.ts mapped onto plain <Text>
// and <View>. Deliberately restrained — type scale, hairline rules and the
// Ledger palette, no card chrome; code blocks sit on the machine surface
// because code is machine voice. Links are shown styled but are not tappable:
// a README's links point at the host's filesystem or the wider web, and a
// read-only file viewer should not be a springboard into either.

import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { useTheme } from '../theme';
import type { TypeVariant } from '../theme';
import { Txt } from '../ui';
import { parseMarkdown } from './markdown';
import type { InlineSpan, MdBlock } from './markdown';

/**
 * Heading levels, mapped onto the app's type scale rather than a private set
 * of sizes. h1–h4 stay four distinct steps (26 / 19 / 16 / 15 with their own
 * weights and tracking); anything deeper reads as strong body text.
 */
const HEADING_VARIANTS: readonly TypeVariant[] = ['title', 'heading', 'subheading', 'bodyStrong'];

/** The bullet/number gutter. One step of the spacing scale. */
const MARKER_COLUMN = 24;

interface Palette {
  readonly theme: ReturnType<typeof useTheme>;
}

function SpanText({ spans, base }: { spans: readonly InlineSpan[]; base: TextStyle } & Record<never, never>) {
  const theme = useTheme();
  // Raw <Text>, not <Txt>: this node exists to host per-span child <Text>
  // runs (bold / italic / inline code / link), which <Txt> cannot express.
  // Its style still comes from the scale, via the `base` the caller builds.
  return (
    <Text selectable style={base}>
      {spans.map((span, index) => (
        <Text
          key={index}
          style={[
            span.bold ? { fontWeight: theme.type.bodyStrong.fontWeight as TextStyle['fontWeight'] } : null,
            span.italic ? { fontStyle: 'italic' } : null,
            span.code
              ? {
                  fontFamily: theme.font.mono,
                  // Inline code must track the line it sits in — a heading's
                  // `code` span is heading-sized — so this stays relative to
                  // the host size rather than pinning a scale step.
                  fontSize: (base.fontSize ?? theme.type.body.fontSize) - 2,
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
  const body: TextStyle = { ...(theme.type.body as TextStyle), color: theme.colors.text };

  switch (block.kind) {
    case 'heading': {
      const variant = HEADING_VARIANTS[Math.min(block.level, HEADING_VARIANTS.length) - 1];
      return (
        <SpanText
          spans={block.spans}
          base={{
            ...(theme.type[variant] as TextStyle),
            color: theme.colors.text,
            marginTop: block.level <= 2 ? theme.space.sm : theme.space.xs,
          }}
        />
      );
    }
    case 'paragraph':
      return <SpanText spans={block.spans} base={body} />;
    case 'code':
      // Code is machine voice, so it sits on the machine surface — true-dark
      // in both themes, square, no border box (docs/DESIGN.md §3.4).
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          style={{
            backgroundColor: theme.colors.machine,
            borderRadius: theme.radius.xs,
          }}
          contentContainerStyle={{ padding: theme.space.sm }}
        >
          {/* Raw <Text>, not <Txt>: a fenced block is the machine's voice,
              rendered verbatim on the machine surface, and its style comes
              straight off the mono step of the scale. */}
          <Text selectable style={{ ...(theme.type.mono as TextStyle), color: theme.colors.onMachine }}>
            {block.text.length > 0 ? block.text : ' '}
          </Text>
        </ScrollView>
      );
    case 'quote':
      return (
        <View
          style={{
            borderLeftWidth: theme.layout.ruleEmphasis,
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
          <Txt variant="body" tone="dim" style={{ minWidth: MARKER_COLUMN }}>
            {block.ordered ? block.marker : '•'}
          </Txt>
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
