// The live JPEG frame, outside React state.
//
// Holding the data URI in `useScreenStream`'s state re-rendered the whole
// screen route — dock, HUD, sheets — at the frame rate. Here the stream
// writes a module-level slot and only the leaf `<Image>` subscribes, so a
// frame costs one leaf render. Same shape as home/preview-store.ts.

import { useSyncExternalStore } from 'react';

let frameUri: string | null = null;
let listeners: readonly (() => void)[] = [];

export function setFrameUri(uri: string | null): void {
  if (uri === frameUri) return;
  frameUri = uri;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

/** The newest JPEG frame as a data URI, re-rendering the caller per frame. */
export function useFrameUri(): string | null {
  return useSyncExternalStore(subscribe, () => frameUri, () => null);
}
