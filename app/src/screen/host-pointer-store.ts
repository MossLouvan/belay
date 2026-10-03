// The live host pointer, outside React state. Moves arrive at up to 60 Hz;
// only the pointer leaf subscribes, so the screen route around it never
// re-renders for one (the frame-store pattern).

import { useSyncExternalStore } from 'react';

import type { PointerImage, PointerMessage } from './host-pointer';

export interface HostPointerState {
  readonly x: number;
  readonly y: number;
  readonly cursor: PointerImage | null;
}

let current: HostPointerState | null = null;
const listeners = new Set<() => void>();
const publish = (next: HostPointerState | null): void => {
  current = next;
  listeners.forEach((l) => l());
};

/** Apply one message; a move without an image keeps the last shape. */
export const applyPointer = (msg: PointerMessage): void =>
  publish({ x: msg.x, y: msg.y, cursor: msg.cursor ?? current?.cursor ?? null });

/** Forget the pointer — the codec changed or the socket closed. */
export const clearPointer = (): void => { if (current !== null) publish(null); };

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export const useHostPointer = (): HostPointerState | null =>
  useSyncExternalStore(subscribe, () => current, () => current);

/** Whether a host pointer is live — a boolean snapshot, so a subscriber
 *  re-renders when the pointer appears or goes, never per move. */
export const useHasHostPointer = (): boolean =>
  useSyncExternalStore(subscribe, () => current !== null, () => current !== null);
