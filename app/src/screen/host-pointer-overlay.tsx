// The host's real pointer, painted over the H.264 picture. Geometry lives in
// host-pointer.ts (tested); this leaf is the only thing that re-renders when
// the pointer moves.

import React, { useMemo } from 'react';
import { Image } from 'react-native';

import { placePointer } from './host-pointer';
import { useHostPointer } from './host-pointer-store';
import type { Size } from './model';

export function HostPointer({ stage, zoom }: { stage: Size; zoom: number }) {
  const pointer = useHostPointer();
  const png = pointer?.cursor?.png;
  // One source object per shape: a fresh `{uri}` every move would make the
  // Image re-decode the PNG at the pointer's rate.
  const source = useMemo(() => (png ? { uri: `data:image/png;base64,${png}` } : null), [png]);
  const place = pointer ? placePointer(pointer, pointer.cursor, stage, zoom) : null;
  if (!place || !source) return null;
  return (
    <Image
      testID="host-pointer"
      source={source}
      fadeDuration={0}
      style={{ position: 'absolute', ...place }}
    />
  );
}
