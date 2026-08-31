// Native PDF viewer: WKWebView rendering the document straight off
// /files/raw. iOS's built-in PDF machinery does the paging — swipe to move
// between pages, pinch to zoom — which is why this is a WebView and not a
// dedicated PDF native module: react-native-webview is the most battle-tested
// module in the ecosystem and Expo pins its version, whereas a PDF-specific
// module would be one more thing to break the iOS build for a viewer WKWebView
// already contains.
//
// The Authorization header rides on `source.headers` — WKWebView applies it to
// the main-document request, so the token never touches the URL. The web build
// resolves pdf-view.web.tsx instead.

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme';
import { EmptyState } from '../ui';
import { previewTooLarge } from '../files-format';
import { api } from '../api';

export interface PdfViewProps {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export function PdfView({ name, path, size }: PdfViewProps) {
  const theme = useTheme();
  const tooLarge = previewTooLarge('pdf', size);
  const [error, setError] = useState('');
  const request = useMemo(() => api.rawFileRequest(path), [path]);

  if (tooLarge) {
    return <EmptyState testID="viewer-too-large" title="Too large to preview" message={tooLarge} />;
  }
  if (error) {
    return <EmptyState testID="viewer-pdf-error" title="Could not show this PDF" message={error} />;
  }

  return (
    <WebView
      testID="viewer-pdf"
      accessibilityLabel={name}
      source={{ uri: request.uri, headers: request.headers }}
      // The document is from the host's disk; nothing in a PDF needs scripts.
      javaScriptEnabled={false}
      onError={(event) => setError(event.nativeEvent.description || 'the document could not be loaded')}
      onHttpError={(event) => setError(`the host refused the document (${event.nativeEvent.statusCode})`)}
      startInLoadingState
      renderLoading={() => (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bg }}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      )}
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
    />
  );
}
