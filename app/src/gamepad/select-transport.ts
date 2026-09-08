// Picks the wire for use-gamepad.ts: the native session when this binary has
// it, else the JavaScript loop (web, Expo Go, older builds). Split from
// transport.ts so that file has no native import and stays unit-testable.

import { gamepadNative, hasNativeSession } from '../../modules/belay-gamepad/src';
import { jsTransport, nativeTransport } from './transport';
import type { GamepadTransport, TransportEvents } from './transport';

export function createTransport(events: TransportEvents): GamepadTransport {
  return hasNativeSession() ? nativeTransport(events, gamepadNative) : jsTransport(events);
}
