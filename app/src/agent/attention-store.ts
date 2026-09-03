// The shared, always-current view of every agent session — what the tab
// badge, the cross-tab "needs you" banner and the session list all read.
//
// A module-level store rather than a React context on purpose: the consumers
// live in different corners of the tree (the tab bar, a banner over every
// tab, the Agent tab's own list), and threading a provider above all of them
// would mean rewriting the tabs layout this store is only supposed to be
// *mounted* from. `useSyncExternalStore` gives the same semantics with none
// of the nesting.
//
// Push first, poll as the parachute: the host's /ws/attention socket sends a
// tiny all-sessions summary the instant anything changes, so a session that
// flips to waiting shows on the badge in the same breath. The old 3-second
// poll of /agent/sessions survives only as the fallback while that socket is
// down — a host restarting, a radio flapping, or a host too old to have the
// route — and each fallback tick also retries the socket, so the store heals
// itself back onto the push path. `/ws/agent` remains one-socket-per-open-
// session for the live feed; this socket is the one cheap answer about *all*
// sessions.
//
// On background notification, honestly: when the app leaves the foreground,
// iOS suspends this JS and both the socket and the fallback stop — there is
// no self-hosted way to ping a pocketed phone without real push
// infrastructure (an APNs-capable relay, a self-hosted ntfy the host POSTs
// to, or Live Activities). Rather than pretend, the in-app story is made
// excellent and the host's approval window is long and visible. The
// remote-push menu lives in the product review; nothing here claims to fire
// when the app is asleep.

import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api, getConnection, wsUrl } from '../api';
import type { AgentSessionMeta } from '../api';
import { ATTENTION_RETRY_MS, applyAttentionPush, parseAttentionMessage } from './attention';

export interface AttentionState {
  /** Latest session list; null until the first successful fetch. */
  readonly sessions: readonly AgentSessionMeta[] | null;
  /** When `sessions` was last refreshed — the "now" its countdowns tick from. */
  readonly fetchedAt: number;
  /** Last fetch failure; empty while the host answers. */
  readonly error: string;
  /** The session currently open in the Agent tab, so the banner can defer to it. */
  readonly openId: string | null;
}

let state: AttentionState = Object.freeze({ sessions: null, fetchedAt: 0, error: '', openId: null });
const listeners = new Set<() => void>();

function setState(patch: Partial<AttentionState>): void {
  state = Object.freeze({ ...state, ...patch });
  for (const fn of listeners) fn();
}

export function getAttention(): AttentionState {
  return state;
}

export function subscribeAttention(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The Agent tab reports which session it has open; everyone else reads it. */
export function setOpenSession(id: string | null): void {
  if (state.openId !== id) setState({ openId: id });
}

/**
 * Drop everything tied to a specific host — call it the instant the active
 * computer changes. The store is module-level and its session ids, open
 * session and pending-approval banner are all scoped to one host; carrying
 * them across a switch opens `/ws/agent?session=<old-id>` against the new host
 * and POSTs the old host's approvals to the new one. Cleared to the pristine
 * "nothing fetched yet" shape — and the push socket, which is equally bound to
 * the old host, is torn down and reopened against the new one.
 */
export function resetAttention(): void {
  setState({ sessions: null, fetchedAt: 0, error: '', openId: null });
  stopLoops();
  if (holders > 0 && AppState.currentState === 'active') start();
}

/**
 * One fetch of the full list. Errors land in state instead of throwing. Kept
 * public and unchanged: it is the fallback poll's body, the "sync the details
 * a push could not carry" step, and the manual pull-to-refresh path.
 */
export async function refreshAttention(): Promise<void> {
  if (!getConnection()) return;
  try {
    const { sessions } = await api.agentSessions();
    setState({ sessions, fetchedAt: Date.now(), error: '' });
  } catch (e: unknown) {
    setState({ error: e instanceof Error ? e.message : 'could not reach the host' });
  }
}

/**
 * Answer an approval from anywhere — the banner's Allow/Deny goes through
 * here. The immediate refresh makes the banner clear on the next frame the
 * host confirms, rather than lingering until a push or fallback tick.
 */
export async function answerApproval(sessionId: string, approvalId: string, allow: boolean): Promise<void> {
  await api.agentApprove(sessionId, approvalId, allow);
  await refreshAttention();
}

// ---- socket + fallback lifecycle -------------------------------------------

let holders = 0;
let socket: WebSocket | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: { remove: () => void } | null = null;
// Bumped whenever the lifecycle stops or restarts, so an async socket open
// (the ticket fetch takes a round trip) that resolves after its world ended
// discards itself instead of resurrecting a dead loop.
let generation = 0;

function running(gen: number): boolean {
  return gen === generation && holders > 0 && AppState.currentState === 'active';
}

function closeSocket(): void {
  if (!socket) return;
  const s = socket;
  socket = null;
  s.onopen = null;
  s.onmessage = null;
  s.onerror = null;
  s.onclose = null;
  try { s.close(); } catch { /* already closing */ }
}

function stopLoops(): void {
  generation += 1;
  closeSocket();
  if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
}

/** Fresh generation: fetch once now, then live on the push socket. */
function start(): void {
  generation += 1;
  const gen = generation;
  void refreshAttention();
  void openSocket(gen);
}

/**
 * While the socket is down: one slow poll tick that also retries the socket,
 * so degraded mode both stays truthful and keeps trying to stop being
 * degraded. One timer, never stacked.
 */
function scheduleFallback(gen: number): void {
  if (!running(gen)) return;
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (!running(gen)) return;
    void refreshAttention();
    void openSocket(gen);
  }, ATTENTION_RETRY_MS);
}

async function openSocket(gen: number): Promise<void> {
  if (!running(gen) || socket) return;
  if (!getConnection()) { scheduleFallback(gen); return; }

  let opened: WebSocket;
  try {
    opened = new WebSocket(await wsUrl('/ws/attention'));
  } catch {
    // No ticket, no route (old host), no network — the fallback poll carries
    // the surface and keeps retrying this path.
    scheduleFallback(gen);
    return;
  }
  if (!running(gen)) { try { opened.close(); } catch { /* never opened */ } return; }
  socket = opened;

  opened.onopen = () => {
    if (socket !== opened) return;
    // The push channel is live: cancel the fallback and sync the full rows
    // once, so titles/expiries are current from the first pushed summary.
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    void refreshAttention();
  };
  opened.onmessage = (event: MessageEvent) => {
    if (socket !== opened) return;
    const rows = parseAttentionMessage(String(event.data));
    if (!rows) return;
    const { sessions, needsFetch } = applyAttentionPush(state.sessions, rows);
    if (sessions !== state.sessions && sessions !== null) {
      setState({ sessions, fetchedAt: Date.now(), error: '' });
    }
    if (needsFetch) void refreshAttention();
  };
  opened.onerror = () => { /* onclose follows and owns recovery */ };
  opened.onclose = () => {
    if (socket !== opened) return;
    socket = null;
    scheduleFallback(gen);
  };
}

/**
 * Ref-counted: every consumer calls this on mount; the first starts the
 * socket, the last teardown stops everything. The whole lifecycle pauses
 * whenever the app leaves the foreground (iOS would suspend it anyway; this
 * makes the pause deliberate and symmetric on every platform) and restarts —
 * immediate fetch, fresh socket — on return, so a reopened app never shows a
 * stale badge while a reconnect ambles up.
 */
export function startAttentionPolling(): () => void {
  holders += 1;
  if (holders === 1) {
    if (AppState.currentState === 'active') start();
    appStateSub = AppState.addEventListener('change', (next) => {
      if (holders === 0) return;
      stopLoops();
      if (next === 'active') start();
    });
  }
  return () => {
    holders -= 1;
    if (holders > 0) return;
    stopLoops();
    appStateSub?.remove();
    appStateSub = null;
  };
}

/** The store as a hook. Mounting any consumer keeps the push channel alive. */
export function useAgentAttention(): AttentionState {
  const snapshot = useSyncExternalStore(subscribeAttention, getAttention, getAttention);
  useEffect(() => startAttentionPolling(), []);
  return snapshot;
}
