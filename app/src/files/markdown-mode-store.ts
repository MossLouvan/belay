// AsyncStorage persistence for the markdown rendered/source choice — split
// from markdown-mode.ts so the pure logic stays testable under node. Same
// pattern as settings/theme-mode.ts: never throw, a broken store just means
// the default.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { MARKDOWN_MODE_KEY, normalizeMarkdownMode } from './markdown-mode';
import type { MarkdownMode } from './markdown-mode';

export async function loadMarkdownMode(): Promise<MarkdownMode> {
  try {
    return normalizeMarkdownMode(await AsyncStorage.getItem(MARKDOWN_MODE_KEY));
  } catch {
    return 'fancy';
  }
}

export async function persistMarkdownMode(mode: MarkdownMode): Promise<void> {
  try {
    await AsyncStorage.setItem(MARKDOWN_MODE_KEY, mode);
  } catch {
    // The choice still applies for this session.
  }
}
