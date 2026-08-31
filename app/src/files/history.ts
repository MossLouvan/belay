// Back/forward history for the Files tab, the same model as Finder's (and every
// browser's) toolbar arrows: a linear stack plus a cursor. Visiting somewhere
// new truncates everything ahead of the cursor — once you branch off, the old
// forward trail is gone, which is exactly how people expect these buttons to
// behave and the only model that keeps them predictable.
//
// Kept pure and JSX-free so the node test runner can exercise it directly.

export interface NavHistory {
  readonly stack: readonly string[];
  readonly index: number;
}

export const emptyHistory: NavHistory = Object.freeze({ stack: [], index: -1 });

export const currentPath = (history: NavHistory): string | null =>
  history.index >= 0 && history.index < history.stack.length ? history.stack[history.index] : null;

export const canGoBack = (history: NavHistory): boolean => history.index > 0;

export const canGoForward = (history: NavHistory): boolean =>
  history.index >= 0 && history.index < history.stack.length - 1;

/**
 * Record an arrival at `path`. Re-arriving where we already stand (a refresh,
 * or tapping the crumb for the current folder) must be a no-op — pushing a
 * duplicate would make Back appear to do nothing on its first press.
 */
export function visitPath(history: NavHistory, path: string): NavHistory {
  if (currentPath(history) === path) return history;
  const stack = [...history.stack.slice(0, history.index + 1), path];
  return { stack, index: stack.length - 1 };
}

export function goBack(history: NavHistory): NavHistory {
  if (!canGoBack(history)) return history;
  return { ...history, index: history.index - 1 };
}

export function goForward(history: NavHistory): NavHistory {
  if (!canGoForward(history)) return history;
  return { ...history, index: history.index + 1 };
}
