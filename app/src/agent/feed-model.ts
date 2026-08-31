// Pure shaping for the session feed: pairing each tool result with the call
// that produced it, and the words on the collapsed-output toggle. No React
// and no JSX, so `feed-model.test.mjs` can import it straight into Node.
//
// The wire keeps calls and results as separate events — the host streams them
// as they happen — but the phone reads better when a result hangs under its
// call instead of appearing as a floating block several narration lines
// later. Pairing happens here, at render time, so the reducer and the caps
// stay untouched and an old host that never sends results costs nothing.

import type { AgentEvent } from '../api';

/** One feed line: an event, plus the tool result attached to it if it was a
 * tool call whose answer has arrived. */
export interface FeedItem {
  readonly event: AgentEvent;
  readonly result?: AgentEvent;
}

/**
 * Folds tool-result events onto the tool calls they answer, matched by
 * callId. A result whose call is missing — trimmed off by the event cap, or
 * from a host/app version mismatch — stands alone rather than vanishing:
 * evidence outranks tidiness.
 */
export function buildFeed(events: readonly AgentEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const awaiting = new Map<string, number>(); // callId → index of the unanswered call
  for (const event of events) {
    if (event.kind === 'tool' && event.callId) {
      awaiting.set(event.callId, items.length);
      items.push({ event });
      continue;
    }
    if (event.kind === 'tool-result' && event.callId) {
      const at = awaiting.get(event.callId);
      if (at !== undefined) {
        items[at] = { event: items[at].event, result: event };
        awaiting.delete(event.callId);
        continue;
      }
    }
    items.push({ event });
  }
  return items;
}

/** Shown lines of a result — the truncated text the host sent, not the full
 * output it measured. */
export function resultLines(result: AgentEvent): number {
  const text = result.text ?? '';
  return text ? text.split('\n').length : 0;
}

/** Whether the host cut this result down before sending it. */
export function resultTruncated(result: AgentEvent): boolean {
  const shown = result.text ?? '';
  return typeof result.chars === 'number' && result.chars > shown.replace(/…$/, '').length;
}

/**
 * The label on the expand/collapse control. Failure is named in the label
 * itself — "it ran" and "it ran and errored" must not read the same even
 * before anyone taps.
 */
export function resultToggleLabel(result: AgentEvent, expanded: boolean): string {
  const arrow = expanded ? '▾' : '▸';
  const n = resultLines(result);
  const count = `${n} ${n === 1 ? 'line' : 'lines'}`;
  return result.ok === false ? `${arrow} ✗ failed · ${count}` : `${arrow} output · ${count}`;
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** The honesty line under a truncated result: what is shown of what existed. */
export function truncationNote(result: AgentEvent): string {
  const shown = (result.text ?? '').replace(/…$/, '').length;
  return `showing first ${kb(shown)} of ${kb(result.chars ?? shown)}`;
}
