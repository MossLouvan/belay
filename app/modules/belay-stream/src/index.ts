// The BWP stream: H.264 over UDP, decoded by VideoToolbox.
//
// Replaces the JPEG-per-frame path. That path sent every frame as an
// independent image over the control WebSocket, so a motionless desktop cost
// exactly as much as a moving one — around 84 KB a frame at roughly 12fps.
// This one sends a keyframe occasionally and differences the rest, measured at
// ~1.3 Mbps for 1080p60 on the host.
//
// `isAvailable` exists because the native module is only present in a build
// that included it. An Expo Go session, a web build, or a dev client compiled
// before this module landed must fall back to JPEG rather than crash on a
// missing view.

import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export interface BwpSource {
  /** The host's address, as the app already knows it. */
  readonly host: string;
  /** The host's UDP port, from its bwpOffer. */
  readonly port: number;
  /** Per-session media key, hex. Never log this. */
  readonly key: string;
  /** Per-session salt, hex. */
  readonly salt: string;
  readonly preset?: string;
  /** The port reserved with `reservePort`, told to the host beforehand. */
  readonly localPort: number;
}

export type StreamStatus =
  | { readonly state: 'opened'; readonly localPort: number }
  | { readonly state: 'live' }
  | { readonly state: 'bitrate'; readonly bps: number }
  | { readonly state: 'error'; readonly error: string };

export interface CursorEvent {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}

export interface BelayStreamViewProps extends ViewProps {
  readonly source: BwpSource | null;
  readonly onStatus?: (e: { nativeEvent: StreamStatus }) => void;
  readonly onCursor?: (e: { nativeEvent: CursorEvent }) => void;
}

interface BelayStreamNativeModule {
  reservePort(): Promise<number>;
}

let nativeModule: BelayStreamNativeModule | null = null;
let nativeView: ComponentType<BelayStreamViewProps> | null = null;

try {
  nativeModule = requireNativeModule<BelayStreamNativeModule>('BelayStream');
  nativeView = requireNativeViewManager<BelayStreamViewProps>('BelayStream');
} catch {
  // Not built into this binary. Callers check `isAvailable` and use JPEG.
  nativeModule = null;
  nativeView = null;
}

/** Whether this build can stream over BWP at all. */
export function isAvailable(): boolean {
  return nativeModule !== null && nativeView !== null;
}

/**
 * Reserve a local UDP port for the stream.
 *
 * Must happen BEFORE asking the host for an offer: the host needs somewhere to
 * send, and frames sent to a port that is not yet bound are simply lost — which
 * looks like a dead stream until the next keyframe rather than like a race.
 */
export async function reservePort(): Promise<number> {
  if (!nativeModule) throw new Error('the native stream module is not in this build');
  return nativeModule.reservePort();
}

export const BelayStreamView = nativeView;
