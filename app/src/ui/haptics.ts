// Safe haptics wrapper.
//
// `expo-haptics` is a declared dependency, but this module never assumes it is
// present or functional: it is loaded lazily inside a try/catch, skipped
// entirely on web (where vibration is at best inconsistent and at worst a
// permission prompt), and every call swallows its own errors. Haptics are a
// garnish — they must never be able to break a build or a tap.

import { Platform } from 'react-native';

declare function require(name: string): unknown;

export type HapticTone = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error';

interface HapticsModule {
  impactAsync?: (style: unknown) => Promise<void>;
  notificationAsync?: (type: unknown) => Promise<void>;
  selectionAsync?: () => Promise<void>;
  ImpactFeedbackStyle?: Record<string, unknown>;
  NotificationFeedbackType?: Record<string, unknown>;
}

// `undefined` means "not looked up yet"; `null` means "looked up, unavailable".
let cached: HapticsModule | null | undefined;
let enabled = Platform.OS !== 'web';

const load = (): HapticsModule | null => {
  if (cached !== undefined) return cached;
  try {
    const mod = require('expo-haptics') as HapticsModule | { default?: HapticsModule };
    const resolved = ('default' in mod && mod.default ? mod.default : mod) as HapticsModule;
    cached = typeof resolved?.impactAsync === 'function' ? resolved : null;
  } catch {
    cached = null;
  }
  return cached;
};

/** Globally mute or unmute haptics (e.g. from a user setting). */
export function setHapticsEnabled(next: boolean): void {
  enabled = next && Platform.OS !== 'web';
}

export function areHapticsEnabled(): boolean {
  return enabled;
}

const IMPACTS: Readonly<Record<string, string>> = { light: 'Light', medium: 'Medium', heavy: 'Heavy' };
const NOTIFICATIONS: Readonly<Record<string, string>> = { success: 'Success', warning: 'Warning', error: 'Error' };

const run = (mod: HapticsModule, tone: HapticTone): Promise<void> | undefined => {
  if (tone === 'selection') return mod.selectionAsync?.();
  const impact = IMPACTS[tone];
  if (impact) return mod.impactAsync?.(mod.ImpactFeedbackStyle?.[impact]);
  const notification = NOTIFICATIONS[tone];
  if (notification) return mod.notificationAsync?.(mod.NotificationFeedbackType?.[notification]);
  return undefined;
};

/**
 * Fire a haptic. Never throws, never rejects, and is a no-op on web or when the
 * native module is missing.
 */
export function haptic(tone: HapticTone = 'light'): void {
  if (!enabled) return;
  const mod = load();
  if (!mod) return;
  try {
    run(mod, tone)?.catch(() => undefined);
  } catch {
    // Native module refused the call; nothing to recover and nothing to report.
  }
}
