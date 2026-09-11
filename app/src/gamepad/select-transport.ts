// Picks the wire for use-gamepad.ts: the native session when this binary has
// it, else the JavaScript loop (web, Expo Go, older builds). Split from
// transport.ts so that file has no native import and stays unit-testable.
//
// The JavaScript loop is also where the UDP Input channel has to be reached
// through JS, because that loop is the one holding the sequence counter. The
// native session posts its own reports to the same channel from its send
// queue, so nothing here is on its path.

import { gamepadNative, hasNativeSession } from '../../modules/belay-gamepad/src';
import { canSendInput, sendInput } from '../../modules/belay-stream/src';
import { jsTransport, makeInputSink, nativeTransport } from './transport';
import type { GamepadTransport, InputSink, TransportEvents } from './transport';

/** Null where this build cannot reach the Input channel at all. The decision
 *  itself lives in transport.ts (makeInputSink) so it is unit-testable. */
export function inputSink(): InputSink | null {
  return makeInputSink(canSendInput, sendInput);
}

export function createTransport(events: TransportEvents): GamepadTransport {
  return hasNativeSession() ? nativeTransport(events, gamepadNative) : jsTransport(events, inputSink());
}
