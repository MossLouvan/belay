// Native image viewer: raster formats through <Image> inside a zoomable
// ScrollView (iOS's own pinch gesture, plus double-tap to jump between fit
// and 2x), SVG through a WebView shell because RN's <Image> is raster-only.
//
// The bytes arrive as a data URI from an authenticated fetch — an <Image src>
// cannot send the Authorization header itself, and a token in the URL is a
// token in someone's access log. The web build resolves image-view.web.tsx
// instead, which needs no WebView.

import React, { useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme';
import { EmptyState } from '../ui';
import { isSvgName, previewTooLarge } from '../files-format';
import { useDataUri } from './use-data-uri';

const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2;
const DOUBLE_TAP_WINDOW_MS = 280;

export interface ImageViewProps {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

/**
 * Minimal shell that centres an SVG data URI and scales it to the viewport.
 * Scripts are disabled twice over — the prop below and the fact that an <img>
 * context never executes them — because an SVG is an arbitrary document from
 * the host's disk, not a trusted asset.
 */
const svgShell = (uri: string, background: string): string =>
  `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<style>html,body{margin:0;height:100%;background:${background}}` +
  `img{width:100%;height:100%;object-fit:contain}</style><img src="${uri}">`;

export function ImageView({ name, path, size }: ImageViewProps) {
  const theme = useTheme();
  const tooLarge = previewTooLarge('image', size);
  const { uri, error, loading } = useDataUri(path, tooLarge === null);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const lastTap = useRef(0);

  if (tooLarge) {
    return <EmptyState testID="viewer-too-large" title="Too large to preview" message={tooLarge} />;
  }
  if (error || failed) {
    return (
      <EmptyState
        testID="viewer-image-error"
        title="Could not show this image"
        message={error || 'The image data could not be decoded on this device.'}
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

  if (isSvgName(name)) {
    return (
      <WebView
        testID="viewer-svg"
        source={{ html: svgShell(uri, theme.colors.bg) }}
        javaScriptEnabled={false}
        style={{ flex: 1, backgroundColor: theme.colors.bg }}
      />
    );
  }

  const onTap = () => {
    const at = Date.now();
    if (at - lastTap.current < DOUBLE_TAP_WINDOW_MS) {
      setZoom((z) => (z > 1 ? 1 : DOUBLE_TAP_ZOOM));
    }
    lastTap.current = at;
  };

  return (
    <ScrollView
      testID="viewer-image"
      maximumZoomScale={MAX_ZOOM}
      minimumZoomScale={1}
      zoomScale={zoom}
      bouncesZoom
      contentContainerStyle={{ flexGrow: 1 }}
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
    >
      <Pressable onPress={onTap} style={{ flex: 1 }} accessibilityRole="imagebutton" accessibilityLabel={name}>
        <Image
          source={{ uri }}
          resizeMode="contain"
          style={{ flex: 1, width: '100%' }}
          onError={() => setFailed(true)}
        />
      </Pressable>
    </ScrollView>
  );
}
