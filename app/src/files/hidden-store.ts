// AsyncStorage persistence for the Files tab's show-hidden choice — split
// from hidden.ts so the pure logic stays testable under node. Same pattern
// as markdown-mode-store.ts: never throw, a broken store just means the
// default.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { HIDDEN_MODE_KEY, normalizeHiddenMode } from './hidden';
import type { HiddenMode } from './hidden';

export async function loadHiddenMode(): Promise<HiddenMode> {
  try {
    return normalizeHiddenMode(await AsyncStorage.getItem(HIDDEN_MODE_KEY));
  } catch {
    return 'hide';
  }
}

export async function persistHiddenMode(mode: HiddenMode): Promise<void> {
  try {
    await AsyncStorage.setItem(HIDDEN_MODE_KEY, mode);
  } catch {
    // The choice still applies for this session.
  }
}
