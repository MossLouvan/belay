import { requireOptionalNativeModule } from 'expo-modules-core';
interface GamepadNative {
  addListener(event: 'onState' | 'onConnection', listener: (event: unknown) => void): { remove(): void };
  start(accent: string): Promise<unknown>;
  stop(): Promise<void>;
  rumble(low: number, high: number): Promise<void>;
}
/** Missing in Expo Go / web: touch controls remain usable. */
export const gamepadNative = requireOptionalNativeModule<GamepadNative>('BelayGamepad');
