// Pure logic for "a session needs you": which sessions are waiting on an
// approval, which one to surface first, and how to say how long is left.
// No React and no react-native, so `attention.test.mjs` runs it in plain Node —
// same contract as model.ts.

import type { AgentSessionMeta, AgentStatus } from '../api';

/**
 * While the /ws/attention socket is down (host restarting, radio flapping, a
 * host too old to have the route), the store falls back to polling the list —
 * and each fallback tick also retries the socket. Ten seconds, not the old
 * three: the poll is now the degraded path, not the product, and a dead link
 * should not be hammered.
 */
export const ATTENTION_RETRY_MS = 10000;

/**
 * The sessions blocked on a human, soonest-to-expire first so the one about
 * to die unanswered is the one the banner shows. A row counts as waiting on
 * either signal — `status === 'waiting'` or a pending summary — because an
 * older host sends only the status, and a race between the two fields must
 * not hide a live ask.
 */
export function waitingSessions(sessions: readonly AgentSessionMeta[]): readonly AgentSessionMeta[] {
  return sessions
    .filter((s) => s.status === 'waiting' || (s.pending !== undefined && s.pending !== null))
    .sort((a, b) => (a.pending?.expiresAt ?? Infinity) - (b.pending?.expiresAt ?? Infinity));
}

/**
 * "28:41", "1:02:03", "0:07" — how long until the ask auto-denies. Empty when
 * there is no deadline (the host is configured to wait forever) and "0:00"
 * once it has passed, never a negative number: past-expiry the host has
 * already denied and the next poll will clear the ask.
 */
export function countdown(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return '';
  const total = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Under two minutes left: the countdown should turn urgent. */
export function expiryUrgent(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt - now < 2 * 60 * 1000;
}

/**
 * The line under the banner's title: the tool and its one-line detail,
 * trimmed so the banner never wraps into a paragraph.
 */
export function askSummary(tool: string, detail: string, max = 80): string {
  const joined = detail ? `${tool}  ${detail}` : tool;
  return joined.length > max ? joined.slice(0, max - 1) + '…' : joined;
}

// ---- the push channel's wire and merge --------------------------------------
//
// /ws/attention pushes `{ type: 'attention', sessions: [{ id, status,
// pending }] }` whenever any session's summary changes — pending is a count
// (the ask on the card plus the queue behind it), never the ask itself. The
// two functions below are the whole client protocol: validate the frame,
// then fold it into the last full fetch. Pure so the store stays a thin
// lifecycle wrapper and the tests run in plain Node.

/** One pushed row: everything the host says about a session, summarised. */
export interface AttentionPushRow {
  readonly id: string;
  readonly status: AgentStatus;
  /** How many approvals wait on this session right now. */
  readonly pending: number;
}

/**
 * Parse one socket frame. Anything that is not a well-formed attention
 * envelope — other message types, truncated JSON, rows missing their id —
 * is null, never a throw and never a half-parsed list: the wire is external
 * input and a hostile or newer host must degrade to "ignored", not garbage
 * state. A missing or negative pending count reads as 0.
 */
export function parseAttentionMessage(raw: string): readonly AttentionPushRow[] | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (typeof msg !== 'object' || msg === null) return null;
  const { type, sessions } = msg as { type?: unknown; sessions?: unknown };
  if (type !== 'attention' || !Array.isArray(sessions)) return null;
  const rows: AttentionPushRow[] = [];
  for (const r of sessions as { id?: unknown; status?: unknown; pending?: unknown }[]) {
    if (typeof r?.id !== 'string' || typeof r?.status !== 'string') return null;
    rows.push({
      id: r.id,
      status: r.status as AgentStatus,
      pending: typeof r.pending === 'number' && r.pending > 0 ? r.pending : 0,
    });
  }
  return rows;
}

/**
 * Fold a push into the last fetched list. Statuses flip immediately and a
 * pending ask whose count hit zero clears immediately — the badge and banner
 * must not wait on a round trip to tell the truth they already know. What a
 * push *cannot* say — a brand-new session's title, a fresh ask's tool and
 * expiry — comes back as `needsFetch: true`, the store's cue to run one
 * refreshAttention. Never mutates its inputs; unchanged rows keep identity
 * so React re-renders only what moved.
 */
export function applyAttentionPush(
  sessions: readonly AgentSessionMeta[] | null,
  rows: readonly AttentionPushRow[],
): { readonly sessions: readonly AgentSessionMeta[] | null; readonly needsFetch: boolean } {
  if (sessions === null) return { sessions: null, needsFetch: true };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const known = new Set(sessions.map((s) => s.id));
  const idsDiffer = rows.length !== sessions.length || rows.some((r) => !known.has(r.id));
  // Any live ask means details (tool, detail, expiry) may be missing or stale
  // here; asks are rare and pushes only fire on change, so one fetch is cheap.
  const needsFetch = idsDiffer || rows.some((r) => r.pending > 0);

  const merged = sessions.map((s) => {
    const row = byId.get(s.id);
    if (!row) return s;
    const status = row.status;
    const clearPending = row.pending === 0 && s.pending != null;
    if (status === s.status && !clearPending) return s;
    return { ...s, status, ...(clearPending ? { pending: null } : {}) };
  });
  const changed = merged.some((s, i) => s !== sessions[i]);
  return { sessions: changed ? merged : sessions, needsFetch };
}
