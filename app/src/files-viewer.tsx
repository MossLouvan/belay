// The read-only viewer the Files screen pushes over itself when a file is
// opened. Dispatches on the kind decided in files-format.ts: text and code get
// the paged monospace body, markdown gets a rendered view with a toggle back
// to source, images and PDFs get real previews fetched over the authenticated
// raw route, and everything else states what it is instead of showing
// mojibake. Each branch lives in src/files/; this file is only the shell.

import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';
import { Banner, Button, EmptyState, Micro, Row, Rule, SegmentedControl, Txt } from './ui';
import { formatSize, kindOf, looksBinary, messageOf } from './files-format';
import type { ViewerKind } from './files-format';
import { api } from './api';
import { TextBody, countLines } from './files/text-body';
import type { ViewerFont } from './files/text-body';
import { MarkdownView } from './files/markdown-view';
import { ImageView } from './files/image-view';
import { PdfView } from './files/pdf-view';
import { toggledMarkdownMode } from './files/markdown-mode';
import type { MarkdownMode } from './files/markdown-mode';
import { loadMarkdownMode, persistMarkdownMode } from './files/markdown-mode-store';

/** The host truncates a text read at this size and sets `truncated`. */
const READ_LIMIT_LABEL = '512 KB';

export interface OpenFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly kind: ViewerKind;
  /** Present for text and markdown, which the Files screen fetches up front. */
  readonly content?: string;
  readonly truncated?: boolean;
}

export interface FileViewerProps {
  file: OpenFile;
  onClose: () => void;
}

const FONT_OPTIONS = [
  { value: 'sm', label: 'S' },
  { value: 'md', label: 'M' },
  { value: 'lg', label: 'L' },
] as const;

/** Finder-style kind label for a file that is, by definition, not a folder. */
const kindLabelOf = (file: OpenFile): string =>
  kindOf({ name: file.name, path: file.path, dir: false, size: file.size, mtime: 0 });

function TruncatedBanner() {
  const theme = useTheme();
  return (
    <Banner
      testID="viewer-truncated"
      status="warn"
      title="Showing the start of this file"
      message={`The host stops reading at ${READ_LIMIT_LABEL}, so everything past that point is not here.`}
      style={{ marginHorizontal: theme.layout.margin, marginBottom: theme.space.xs }}
    />
  );
}

/** The font-size / wrap toolbar shared by the text branches. */
function TextControls({
  font, wrap, onFont, onWrap,
}: {
  font: ViewerFont; wrap: boolean; onFont: (f: ViewerFont) => void; onWrap: (w: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <Row gap="sm" style={{ paddingHorizontal: theme.layout.margin, paddingBottom: theme.space.xs }}>
      <SegmentedControl
        testID="viewer-font"
        accessibilityLabel="Text size"
        options={[...FONT_OPTIONS]}
        value={font}
        onChange={onFont}
        style={{ width: 108 }}
      />
      <SegmentedControl
        testID="viewer-wrap"
        accessibilityLabel="Line wrapping"
        options={[{ value: 'off', label: 'No wrap' }, { value: 'on', label: 'Wrap' }]}
        value={wrap ? 'on' : 'off'}
        onChange={(next) => onWrap(next === 'on')}
        style={{ flex: 1 }}
      />
    </Row>
  );
}

/** Plain text and code: the paged monospace body, with the binary tripwire. */
function TextViewer({ file }: { file: OpenFile }) {
  const [wrap, setWrap] = useState(false);
  const [font, setFont] = useState<ViewerFont>('md');
  const [forceText, setForceText] = useState(false);

  const content = file.content ?? '';
  const binary = useMemo(() => looksBinary(content), [content]);

  if (binary && !forceText) {
    return (
      <EmptyState
        testID="viewer-binary"
        title="This looks like a binary file"
        message={`${kindLabelOf(file)} · ${formatSize(file.size)}. Rendering it as text would produce nothing but mojibake.`}
        action={{ label: 'Show raw text anyway', onPress: () => setForceText(true) }}
      />
    );
  }
  return (
    <>
      <TextControls font={font} wrap={wrap} onFont={setFont} onWrap={setWrap} />
      {file.truncated ? <TruncatedBanner /> : null}
      <TextBody content={content} wrap={wrap} font={font} />
    </>
  );
}

/**
 * Markdown: rendered by default, with the toggle back to raw source. The last
 * chosen mode is restored on every open and remembered across launches —
 * someone reading markdown as source is doing it on purpose, and resetting
 * the toggle per file would make it feel broken.
 */
function MarkdownViewer({ file }: { file: OpenFile }) {
  const theme = useTheme();
  const [mode, setMode] = useState<MarkdownMode | null>(null);
  const [wrap, setWrap] = useState(true);
  const [font, setFont] = useState<ViewerFont>('md');

  useEffect(() => {
    let alive = true;
    loadMarkdownMode().then((stored) => { if (alive) setMode(stored); });
    return () => { alive = false; };
  }, []);

  // One frame of nothing while storage answers beats rendering the default and
  // snapping to the saved mode in front of the user.
  if (mode === null) return <View style={{ flex: 1 }} />;

  const onMode = (next: string) => {
    const chosen = next === 'raw' ? 'raw' : 'fancy';
    if (chosen === mode) return;
    setMode(chosen);
    void persistMarkdownMode(chosen);
  };

  return (
    <>
      <Row gap="sm" style={{ paddingHorizontal: theme.layout.margin, paddingBottom: theme.space.xs }}>
        <SegmentedControl
          testID="viewer-md-mode"
          accessibilityLabel="Markdown display mode"
          options={[{ value: 'fancy', label: 'Rendered' }, { value: 'raw', label: 'Source' }]}
          value={mode}
          onChange={onMode}
          style={{ flex: 1 }}
        />
      </Row>
      {mode === 'raw' ? <TextControls font={font} wrap={wrap} onFont={setFont} onWrap={setWrap} /> : null}
      {file.truncated ? <TruncatedBanner /> : null}
      {mode === 'raw'
        ? <TextBody content={file.content ?? ''} wrap={wrap} font={font} />
        : <MarkdownView content={file.content ?? ''} />}
    </>
  );
}

/**
 * A format nothing here can render. Says what the file is and how big it is —
 * strictly more useful than a wall of mojibake — but still offers the text
 * fallback, because "binary" is an inference from the extension and sometimes
 * a .bin is a shell script.
 */
function BinaryViewer({ file }: { file: OpenFile }) {
  const [text, setText] = useState<{ content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (text !== null) {
    return <TextViewer file={{ ...file, kind: 'text', content: text.content, truncated: text.truncated }} />;
  }

  const fetchAsText = async () => {
    setLoading(true);
    setError('');
    try {
      const read = await api.readFile(file.path);
      setText({ content: read.content, truncated: read.truncated });
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <EmptyState
      testID="viewer-binary"
      title="No preview for this file type"
      message={`${kindLabelOf(file)} · ${formatSize(file.size)}. ${error ? error : 'There is nothing readable to show for this format.'}`}
      action={loading ? undefined : { label: 'Show as text anyway', onPress: () => void fetchAsText() }}
    />
  );
}

export function FileViewer({ file, onClose }: FileViewerProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const caption = file.kind === 'text' || file.kind === 'markdown'
    ? `${formatSize(file.size)} · ${countLines(file.content ?? '')} lines`
    : `${kindLabelOf(file)} · ${formatSize(file.size)}`;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      <Row justify="space-between" gap="sm" style={{ paddingHorizontal: theme.layout.margin, paddingBottom: theme.space.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="subheading" numberOfLines={1} heading>
            {file.name}
          </Txt>
          <Micro numberOfLines={1}>{caption}</Micro>
        </View>
        <Button testID="viewer-close" label="Close" onPress={onClose} size="sm" variant="secondary" />
      </Row>
      <Rule style={{ marginBottom: theme.space.xs }} />

      {file.kind === 'image' ? <ImageView name={file.name} path={file.path} size={file.size} /> : null}
      {file.kind === 'pdf' ? <PdfView name={file.name} path={file.path} size={file.size} /> : null}
      {file.kind === 'markdown' ? <MarkdownViewer file={file} /> : null}
      {file.kind === 'text' ? <TextViewer file={file} /> : null}
      {file.kind === 'binary' ? <BinaryViewer file={file} /> : null}

      <View style={{ height: theme.space.sm }} />
    </View>
  );
}
