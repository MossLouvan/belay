// The Files tab's dotfile filter and its remembered on/off choice. A home
// directory opens on `.zshrc`, `.git`, `.config`… before anything a phone
// user came for, so hidden entries are dropped by default and a "Show
// hidden" label brings them back — persisted, because someone who works in
// dotfiles works in them every session. Persistence lives in
// hidden-store.ts; importing AsyncStorage here would drag react-native into
// the node test runner.

import type { FileEntry } from '../api';

export type HiddenMode = 'hide' | 'show';

// 'belay.*' like every other persisted choice (see markdown-mode.ts).
export const HIDDEN_MODE_KEY = 'belay.filesHiddenMode';

/** Unix convention, which macOS shares: a leading dot means hidden. */
export const isHiddenName = (name: string): boolean => name.startsWith('.');

/** A new array with the hidden entries dropped; the input is never touched. */
export const withoutHidden = (entries: readonly FileEntry[]): readonly FileEntry[] =>
  entries.filter((entry) => !isHiddenName(entry.name));

/** How many entries the filter would drop — the honest "· 8 hidden" count. */
export const hiddenCount = (entries: readonly FileEntry[]): number =>
  entries.reduce((count, entry) => (isHiddenName(entry.name) ? count + 1 : count), 0);

/**
 * Whatever storage held, made safe. Hide is the default — the clean listing
 * is the point of the filter; seeing dotfiles is the opt-in.
 */
export const normalizeHiddenMode = (value: unknown): HiddenMode =>
  value === 'show' ? 'show' : 'hide';

export const toggledHiddenMode = (mode: HiddenMode): HiddenMode =>
  mode === 'hide' ? 'show' : 'hide';
