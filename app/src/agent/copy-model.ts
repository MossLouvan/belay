// Pure logic behind the transcript's Copy affordance. No React and no JSX,
// so `copy-model.test.mjs` can import it straight into Node.
//
// Every message in the feed is selectable, so a fingertip can already lift a
// phrase. The Copy control exists for the other gesture — "give me this whole
// block" — which on a phone means fighting selection handles across a
// paragraph. It earns its place only where that fight is real: prompts the
// user may want to re-send elsewhere, and prose long enough that dragging
// handles across it is a chore. A three-word narration line gets no chrome.

import type { AgentEvent } from '../api';

/** How long the ✓/✗ outcome flash stays on the Copy label. */
export const COPY_FLASH_MS = 1500;

/** One-line prose this long earns its own Copy control; anything shorter is
 * served well enough by text selection. Multi-line prose always qualifies. */
export const MESSAGE_COPY_MIN_CHARS = 80;

/** The Copy control's lifecycle: at rest, or flashing what just happened. */
export type CopyFlash = 'idle' | 'copied' | 'failed';

/** The words on the control — same ✓/✗ flash idiom as the Files path bar, so
 * "Copy" reads identically everywhere in the app. */
export function copyLabel(flash: CopyFlash): string {
  if (flash === 'copied') return '✓ Copied';
  if (flash === 'failed') return '✗ Failed';
  return 'Copy';
}

/**
 * Whether a feed message renders its own Copy control. User prompts always do
 * (re-sending a prompt elsewhere is the tab's most common copy); Claude's
 * narration only once it is multi-line or long enough that selection handles
 * become a fight. Everything else — tool lines, tallies, errors — stays
 * selectable but unadorned.
 */
export function showMessageCopy(event: AgentEvent): boolean {
  const text = event.text ?? '';
  if (text.trim().length === 0) return false;
  if (event.kind === 'user') return true;
  if (event.kind !== 'text') return false;
  return text.includes('\n') || text.length >= MESSAGE_COPY_MIN_CHARS;
}
