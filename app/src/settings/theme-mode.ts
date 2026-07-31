// Persistence for the user's appearance choice.
//
// The theme store in ../theme is deliberately in-memory (it has no dependency on
// AsyncStorage). Persisting the choice is a screen-level concern, so it lives
// here and is restored once, from the root layout, before the first paint.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setThemeMode, ThemeMode } from '../theme';

const MODE_KEY = 'tether.themeMode';

const MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

const isThemeMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (MODES as readonly string[]).includes(value);

/**
 * Applies any previously saved appearance choice. Never throws: a failure to
 * read storage just leaves the app on its built-in default.
 */
export async function restoreThemeMode(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(MODE_KEY);
    if (isThemeMode(saved)) setThemeMode(saved);
  } catch {
    // Appearance is cosmetic — never let it block app start.
  }
}

/** Applies and remembers an appearance choice. */
export async function persistThemeMode(mode: ThemeMode): Promise<void> {
  setThemeMode(mode);
  try {
    await AsyncStorage.setItem(MODE_KEY, mode);
  } catch {
    // The choice still applies for this session.
  }
}
