// Web build of the PDF viewer: the browser's own PDF machinery inside an
// iframe, which brings its page navigation toolbar along for free. The bytes
// are fetched with the Authorization header and handed over as a blob URL —
// an iframe src cannot carry a header, and the token must never ride in a
// URL that a proxy could log.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../theme';
import { EmptyState } from '../ui';
import { messageOf, previewTooLarge } from '../files-format';
import { api } from '../api';

export interface PdfViewProps {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export function PdfView({ name, path, size }: PdfViewProps) {
  const theme = useTheme();
  const tooLarge = previewTooLarge('pdf', size);
  const [blobUrl, setBlobUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (tooLarge) return undefined;
    const controller = new AbortController();
    let url = '';
    const request = api.rawFileRequest(path);
    fetch(request.uri, { headers: request.headers, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `the host refused the document (${res.status})`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => {
      controller.abort();
      // The blob holds the whole document in browser memory until revoked.
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, tooLarge]);

  if (tooLarge) {
    return <EmptyState testID="viewer-too-large" title="Too large to preview" message={tooLarge} />;
  }
  if (error) {
    return <EmptyState testID="viewer-pdf-error" title="Could not show this PDF" message={error} />;
  }
  if (!blobUrl) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <View testID="viewer-pdf" style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <iframe src={blobUrl} title={name} style={{ border: 0, width: '100%', height: '100%' }} />
    </View>
  );
}
