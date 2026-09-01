// State logic for the markdown viewer's rendered/source toggle. The choice is
// remembered across files and launches — someone who flipped to source is
// usually reading markdown *as* source, and re-flipping on every open would
// make the toggle feel broken. Persistence itself lives in
// markdown-mode-store.ts, because importing AsyncStorage here would drag
// react-native into the node test runner.

export type MarkdownMode = 'fancy' | 'raw';

// 'belay.*' since the bundle id moved and wiped the old container.
// The prefix is load-bearing from the first launch on: silently forgetting
// the choice is the exact failure the persistence exists to avoid.
export const MARKDOWN_MODE_KEY = 'belay.filesMarkdownMode';

/**
 * Whatever storage held, made safe. Rendered is the default — the point of the
 * viewer is the nice reading experience; source is the opt-in.
 */
export const normalizeMarkdownMode = (value: unknown): MarkdownMode =>
  value === 'raw' ? 'raw' : 'fancy';

export const toggledMarkdownMode = (mode: MarkdownMode): MarkdownMode =>
  mode === 'raw' ? 'fancy' : 'raw';
