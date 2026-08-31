// Web build of the image viewer. Browsers render every supported format —
// SVG included — through an ordinary <img>, which is what react-native-web
// compiles <Image> to, so no WebView (which has no web implementation) is
// needed. Pinch/scroll zoom is the browser's own; the viewer just fits the
// image to the viewport. HEIC is the one gap: only Safari decodes it, so a
// failed decode reports itself instead of showing a broken frame.

import React, { useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { useTheme } from '../theme';
import { EmptyState } from '../ui';
import { previewTooLarge } from '../files-format';
import { useDataUri } from './use-data-uri';

export interface ImageViewProps {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export function ImageView({ name, path, size }: ImageViewProps) {
  const theme = useTheme();
  const tooLarge = previewTooLarge('image', size);
  const { uri, error, loading } = useDataUri(path, tooLarge === null);
  const [failed, setFailed] = useState(false);

  if (tooLarge) {
    return <EmptyState testID="viewer-too-large" title="Too large to preview" message={tooLarge} />;
  }
  if (error || failed) {
    return (
      <EmptyState
        testID="viewer-image-error"
        title="Could not show this image"
        message={error || 'This browser cannot decode this image format (HEIC needs Safari).'}
      />
    );
  }
  if (loading || uri === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <View testID="viewer-image" style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <Image
        source={{ uri }}
        resizeMode="contain"
        accessibilityLabel={name}
        style={{ flex: 1, width: '100%' }}
        onError={() => setFailed(true)}
      />
    </View>
  );
}
