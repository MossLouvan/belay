// The "N more waiting" stack under the approval card. Claude's parallel tool
// use raises simultaneous asks; the host queues them FIFO (each on its own
// fail-closed clock) and broadcasts how many stand behind the one on the
// card. This module is that count's whole life on the phone: the wire parse,
// the label, and a single-slot store.
//
// A module-level store, not reducer state, on purpose: the wire message is
// new, and `model.ts`'s parser deliberately drops message types it does not
// know — teaching the whole reducer a new message for one integer would put
// protocol churn in every consumer. Instead `session.ts` (which sees the raw
// socket) feeds this store, and the card alone subscribes. Same pattern as
// attention-store.ts, and single-slot for the same reason `openId` is: one
// session view is on screen at a time, and its socket owns the value.
//
// No React imports — agent tests run this file straight in Node.

export interface ApprovalsWaiting {
  /** Asks queued behind the one on the card. 0 means the card stands alone. */
  readonly waiting: number;
  /** Their tool names, in queue order, for the stack's one-line summary. */
  readonly tools: readonly string[];
}

export const NO_APPROVALS_WAITING: ApprovalsWaiting = Object.freeze({ waiting: 0, tools: [] });

/** Most tool names the label spells out before shrugging with an ellipsis. */
const LABEL_TOOLS_MAX = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function sanitize(waiting: unknown, tools: unknown): ApprovalsWaiting {
  const count = typeof waiting === 'number' && Number.isInteger(waiting) && waiting > 0 ? waiting : 0;
  if (count === 0) return NO_APPROVALS_WAITING;
  const names = Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : [];
  return { waiting: count, tools: names };
}

/**
 * Reads the queue depth out of a raw `/ws/agent` frame. Returns the stack for
 * an `approvals-waiting` broadcast or a `hello` snapshot (which resets the
 * count on reconnect — an older host's hello resets it to none), and null for
 * every other message: null means "this frame says nothing about the queue",
 * and collapsing it to zero would clear the stack on every event broadcast.
 */
export function parseApprovalsWaiting(raw: unknown): ApprovalsWaiting | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === 'approvals-waiting') return sanitize(value.waiting, value.tools);
  if (value.type === 'hello') {
    const w = isRecord(value.session) ? value.session.approvalsWaiting : undefined;
    return isRecord(w) ? sanitize(w.waiting, w.tools) : NO_APPROVALS_WAITING;
  }
  return null;
}

/**
 * The stack's one line: "2 more waiting · Bash · Edit". Null at zero — the
 * card says nothing rather than "0 more waiting". Tool names are capped so a
 * deep stack cannot crowd the card; the count always tells the whole truth.
 */
export function waitingLabel(w: ApprovalsWaiting): string | null {
  if (w.waiting <= 0) return null;
  const shown = w.tools.slice(0, LABEL_TOOLS_MAX);
  const overflow = w.tools.length > LABEL_TOOLS_MAX ? ['…'] : [];
  return [`${w.waiting} more waiting`, ...shown, ...overflow].join(' · ');
}

// ---- the store --------------------------------------------------------------

let current: ApprovalsWaiting = NO_APPROVALS_WAITING;
const listeners = new Set<() => void>();

const sameWaiting = (a: ApprovalsWaiting, b: ApprovalsWaiting): boolean =>
  a.waiting === b.waiting && a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]);

/** The session socket writes here; identical values do not re-render. */
export function setApprovalsWaiting(next: ApprovalsWaiting): void {
  if (sameWaiting(current, next)) return;
  current = next;
  for (const fn of listeners) fn();
}

export function getApprovalsWaiting(): ApprovalsWaiting {
  return current;
}

export function subscribeApprovalsWaiting(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
