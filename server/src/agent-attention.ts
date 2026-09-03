// The attention push channel: one multiplexed /ws/attention socket per phone,
// carrying a tiny summary of EVERY session — id, status, how many approvals
// wait — the instant anything changes. It replaces the app's 3-second poll of
// /agent/sessions for the badge / banner / list surfaces; the poll survives
// only as the app's fallback when this socket is down.
//
// Deliberately thin: the wire carries no titles, no tool inputs, no expiry
// clocks. Those ride the REST list the phone re-fetches when a summary says
// something *new* is pending; a status flip alone needs no fetch at all. That
// keeps this socket cheap enough to push on every change without thinking.
//
// Shape mirrors recording-routes.ts / agent-routes.ts: the hub is built
// against injected deps (a list function, a change subscription) so the tests
// never spawn a session, and index.ts wires the real agent.ts pair in with
// one call.

import type { WebSocket } from 'ws';
import { listSessions, onSessionsChanged } from './agent.js';

/** One session on the wire — the whole story the badge needs. */
export interface AttentionRow {
  readonly id: string;
  readonly status: string;
  /** Pending approvals: the ask on the card plus everything queued behind it. */
  readonly pending: number;
}

/** What attentionRows needs from a listSessions() row. */
interface SessionSummaryLike {
  readonly id: string;
  readonly status: string;
  readonly pending?: { readonly waiting?: number } | null;
}

/** The subset of a ws socket the hub touches — fakeable in tests. */
export interface AttentionSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  on(event: 'close' | 'message', fn: () => void): void;
}

/** Squeeze the session list down to the per-session summary rows. */
export function attentionRows(sessions: readonly SessionSummaryLike[]): readonly AttentionRow[] {
  return sessions.map((s) => ({
    id: s.id,
    status: s.status,
    pending: s.pending ? 1 + (s.pending.waiting ?? 0) : 0,
  }));
}

/** Same rows, same order, same values — the diff that gates the wire. */
export function rowsEqual(a: readonly AttentionRow[], b: readonly AttentionRow[]): boolean {
  return a.length === b.length &&
    a.every((row, i) => row.id === b[i].id && row.status === b[i].status && row.pending === b[i].pending);
}

/** The envelope the phone parses (parseAttentionMessage on the app side). */
export function attentionWire(rows: readonly AttentionRow[]): string {
  return JSON.stringify({ type: 'attention', sessions: rows });
}

interface AttentionHubDeps {
  /** The live session list — agent.ts's listSessions in production. */
  readonly list: () => readonly SessionSummaryLike[];
  /** Change notifications — agent.ts's onSessionsChanged. Returns unhook. */
  readonly subscribe: (fn: () => void) => () => void;
}

export interface AttentionHub {
  handle(ws: AttentionSocket): void;
}

/**
 * The fan-out: every connected socket gets the current summary on arrival and
 * every *changed* summary afterwards. Change notifications fire on every
 * broadcast-worthy event — feed lines included — so pushes are coalesced per
 * tick and diffed against the last wire before anything is sent: a session
 * streaming stdout at full speed produces zero attention traffic until its
 * status or approvals actually move. The upstream subscription exists only
 * while at least one socket is connected.
 */
export function createAttentionHub(deps: AttentionHubDeps): AttentionHub {
  const sockets = new Set<AttentionSocket>();
  let lastRows: readonly AttentionRow[] | null = null;
  let unhook: (() => void) | null = null;
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    flushTimer = null;
    if (sockets.size === 0) return;
    const rows = attentionRows(deps.list());
    if (lastRows !== null && rowsEqual(lastRows, rows)) return;
    lastRows = rows;
    const wire = attentionWire(rows);
    for (const ws of sockets) {
      try { if (ws.readyState === ws.OPEN) ws.send(wire); } catch { /* socket on its way out */ }
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, 0);
    flushTimer.unref?.();
  };

  return {
    handle(ws: AttentionSocket): void {
      sockets.add(ws);
      if (unhook === null) unhook = deps.subscribe(scheduleFlush);
      const rows = attentionRows(deps.list());
      lastRows = rows;
      try { ws.send(attentionWire(rows)); } catch { /* close will follow */ }
      // One-way channel: anything the client says is ignored, not an error.
      ws.on('message', () => {});
      ws.on('close', () => {
        sockets.delete(ws);
        if (sockets.size > 0) return;
        unhook?.();
        unhook = null;
        lastRows = null;
        if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      });
    },
  };
}

// The production hub, wired to agent.ts. Lazy so importing this module for
// its pure functions (tests) never touches session state.
let defaultHub: AttentionHub | null = null;

/** index.ts's upgrade handler for /ws/attention. */
export function handleAttention(ws: WebSocket): void {
  defaultHub ??= createAttentionHub({ list: listSessions, subscribe: onSessionsChanged });
  defaultHub.handle(ws as unknown as AttentionSocket);
}
