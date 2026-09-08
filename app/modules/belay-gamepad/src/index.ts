import { requireOptionalNativeModule } from 'expo-modules-core';
import type { GamepadState } from '../../../src/gamepad/codec';

type GamepadEvent = 'onState' | 'onConnection' | 'onSessionMessage' | 'onSessionClose';

export interface GamepadNative {
  addListener(event: GamepadEvent, listener: (event: unknown) => void): { remove(): void };
  start(accent: string): Promise<unknown>;
  stop(): Promise<void>;
  rumble(low: number, high: number): Promise<void>;
  /**
   * The wire session, run entirely in native code (ios/GamepadSession.swift):
   * a WebSocket to the host plus the 8 ms send loop. Present on iOS builds
   * that carry it; absent in Expo Go, on web, and in older binaries, where
   * use-gamepad.ts falls back to its JavaScript loop.
   */
  startSession?(url: string): Promise<void>;
  stopSession?(): Promise<void>;
  setTouchState?(state: GamepadState): Promise<void>;
  setInputMode?(mode: 'auto' | 'phone'): Promise<void>;
  setSuppressed?(value: boolean): Promise<void>;
}
/** Missing in Expo Go / web: touch controls remain usable. */
export const gamepadNative = requireOptionalNativeModule<GamepadNative>('BelayGamepad');

/** True when the native module can own the socket and timer itself. */
export const hasNativeSession = (native: GamepadNative | null = gamepadNative): boolean =>
  typeof native?.startSession === 'function' && typeof native?.setTouchState === 'function';
