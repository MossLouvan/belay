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
import { attachedClaudeIds, listSessions, onSessionsChanged } from './agent.js';
import { sessionIndex } from './discover.js';
import { hookRows, hooksStore } from './hooks-store.js';
import type { HookRow } from './hooks-store.js';

/** One session on the wire — the whole story the badge needs. */
export interface AttentionRow {
  readonly id: string;
  readonly status: string;
  /** Pending approvals: the ask on the card plus everything queued behind it. */
  readonly pending: number;
}

/**
 * One terminal-started session on the wire: enough for the list to add a
 * row, mark it LIVE, and know when to re-fetch /agent/discovered for the
 * preview and cwd it does not carry. `live` flips without any fetch.
 */
export interface DiscoveredRow {
  readonly id: string;
  readonly live: boolean;
  readonly lastWriteAt: number;
}

/** What discoveredRows needs from a session-index row. */
interface DiscoveredLike {
  readonly claudeSessionId: string;
  readonly live: boolean;
  readonly lastWriteAt: number;
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

/** Squeeze the discovered list down to id + live facts. */
export function discoveredRows(found: readonly DiscoveredLike[]): readonly DiscoveredRow[] {
  return found.map((d) => ({ id: d.claudeSessionId, live: d.live, lastWriteAt: d.lastWriteAt }));
}

/** Same discovered rows, same order — the second half of the wire diff. */
export function discoveredEqual(a: readonly DiscoveredRow[], b: readonly DiscoveredRow[]): boolean {
  return a.length === b.length &&
    a.every((row, i) => row.id === b[i].id && row.live === b[i].live && row.lastWriteAt === b[i].lastWriteAt);
}

/** Same hook rows, same order — the third part of the wire diff. */
export function hooksEqual(a: readonly HookRow[], b: readonly HookRow[]): boolean {
  return a.length === b.length &&
    a.every((row, i) => row.id === b[i].id && row.kind === b[i].kind && row.sessionId === b[i].sessionId);
}

/**
 * The envelope the phone parses (parseAttentionMessage on the app side).
 * `discovered` and `hooks` are omitted entirely when the hub has no source
 * for them, so older phones and the existing tests see exactly the old shape.
 */
export function attentionWire(
  rows: readonly AttentionRow[], discovered?: readonly DiscoveredRow[], hooks?: readonly HookRow[],
): string {
  return JSON.stringify({
    type: 'attention',
    sessions: rows,
    ...(discovered === undefined ? {} : { discovered }),
    ...(hooks === undefined ? {} : { hooks }),
  });
}

interface AttentionHubDeps {
  /** The live session list — agent.ts's listSessions in production. */
  readonly list: () => readonly SessionSummaryLike[];
  /** Change notifications — agent.ts's onSessionsChanged. Returns unhook. */
  readonly subscribe: (fn: () => void) => () => void;
  /** Terminal-started sessions — the session index in production. Optional. */
  readonly discovered?: () => readonly DiscoveredLike[];
  /** Index change notifications (new file, growth, live flip). Returns unhook. */
  readonly subscribeDiscovered?: (fn: () => void) => () => void;
  /** Asks and notices from terminal sessions — the hooks store in production. Optional. */
  readonly hooks?: () => readonly HookRow[];
  readonly subscribeHooks?: (fn: () => void) => () => void;
}

export interface AttentionHub {
  handle(ws: AttentionSocket): void;
  /** How many phones are listening right now — the hooks route's "can anyone answer?" gate. */
  clients(): number;
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
  let lastFound: readonly DiscoveredRow[] | null = null;
  let lastHooks: readonly HookRow[] | null = null;
  let unhook: (() => void) | null = null;
  let unhookFound: (() => void) | null = null;
  let unhookHooks: (() => void) | null = null;
  let flushTimer: NodeJS.Timeout | null = null;

  const found = (): readonly DiscoveredRow[] | undefined =>
    deps.discovered ? discoveredRows(deps.discovered()) : undefined;
  const hooks = (): readonly HookRow[] | undefined => deps.hooks?.();

  const flush = (): void => {
    flushTimer = null;
    if (sockets.size === 0) return;
    const rows = attentionRows(deps.list());
    const disc = found();
    const hk = hooks();
    const sameRows = lastRows !== null && rowsEqual(lastRows, rows);
    const sameFound = disc === undefined || (lastFound !== null && discoveredEqual(lastFound, disc));
    const sameHooks = hk === undefined || (lastHooks !== null && hooksEqual(lastHooks, hk));
    if (sameRows && sameFound && sameHooks) return;
    lastRows = rows;
    lastFound = disc ?? null;
    lastHooks = hk ?? null;
    const wire = attentionWire(rows, disc, hk);
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
      if (unhookFound === null && deps.subscribeDiscovered) unhookFound = deps.subscribeDiscovered(scheduleFlush);
      if (unhookHooks === null && deps.subscribeHooks) unhookHooks = deps.subscribeHooks(scheduleFlush);
      const rows = attentionRows(deps.list());
      const disc = found();
      const hk = hooks();
      lastRows = rows;
      lastFound = disc ?? null;
      lastHooks = hk ?? null;
      try { ws.send(attentionWire(rows, disc, hk)); } catch { /* close will follow */ }
      // One-way channel: anything the client says is ignored, not an error.
      ws.on('message', () => {});
      ws.on('close', () => {
        sockets.delete(ws);
        if (sockets.size > 0) return;
        unhook?.();
        unhook = null;
        unhookFound?.();
        unhookFound = null;
        unhookHooks?.();
        unhookHooks = null;
        lastRows = null;
        lastFound = null;
        lastHooks = null;
        if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      });
    },
    clients(): number { return sockets.size; },
  };
}

// The production hub, wired to agent.ts. Lazy so importing this module for
// its pure functions (tests) never touches session state.
let defaultHub: AttentionHub | null = null;

/** index.ts's upgrade handler for /ws/attention. */
export function handleAttention(ws: WebSocket): void {
  defaultHub ??= createAttentionHub({
    list: listSessions,
    subscribe: onSessionsChanged,
    discovered: () => sessionIndex().list(attachedClaudeIds()),
    subscribeDiscovered: (fn) => sessionIndex().onChange(fn),
    hooks: () => hookRows(hooksStore()),
    subscribeHooks: (fn) => hooksStore().onChange(fn),
  });
  defaultHub.handle(ws as unknown as AttentionSocket);
}

/** Phones listening on /ws/attention right now; 0 before the first ever connects. */
export function attentionClients(): number {
  return defaultHub?.clients() ?? 0;
}
