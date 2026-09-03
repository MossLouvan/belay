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
// Why polling and not a socket: `/ws/agent` is one socket per session and
// exists for the open session's live feed. The attention surface needs one
// cheap answer about *all* sessions ("is anything waiting?"), and a 3-second
// poll of the in-memory session list delivers it with no new server surface
// and no reconnect machinery. The open session still gets its push feed.
//
// On background notification, honestly: when the app leaves the foreground,
// iOS suspends this JS and the poll stops — there is no self-hosted way to
// ping a pocketed phone without real push infrastructure (an APNs-capable
// relay, a self-hosted ntfy the host POSTs to, or Live Activities). Rather
// than pretend, the in-app story is made excellent and the host's approval
// window is long and visible. The remote-push menu lives in the product
// review; nothing here claims to fire when the app is asleep.

import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api, getConnection } from '../api';
import type { AgentSessionMeta } from '../api';
import { ATTENTION_POLL_MS, ATTENTION_RETRY_MS } from './attention';

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
 * "nothing fetched yet" shape so the next poll repopulates from the new host.
 */
export function resetAttention(): void {
  setState({ sessions: null, fetchedAt: 0, error: '', openId: null });
}

/** One fetch of the list. Errors land in state instead of throwing. */
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
 * host confirms, rather than lingering until the poll.
 */
export async function answerApproval(sessionId: string, approvalId: string, allow: boolean): Promise<void> {
  await api.agentApprove(sessionId, approvalId, allow);
  await refreshAttention();
}

// ---- polling lifecycle ------------------------------------------------------

let holders = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: { remove: () => void } | null = null;

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void refreshAttention().then(() => {
      if (holders > 0 && AppState.currentState === 'active') {
        schedule(state.error ? ATTENTION_RETRY_MS : ATTENTION_POLL_MS);
      }
    });
  }, delay);
}

/**
 * Ref-counted: every consumer calls this on mount; the first starts the loop,
 * the last teardown stops it. The loop pauses whenever the app leaves the
 * foreground (iOS would suspend the timer anyway; this just makes the pause
 * deliberate and symmetric on every platform) and refreshes immediately on
 * return, so a reopened app never shows a stale badge while a poll ambles up.
 */
export function startAttentionPolling(): () => void {
  holders += 1;
  if (holders === 1) {
    schedule(0);
    appStateSub = AppState.addEventListener('change', (next) => {
      if (holders === 0) return;
      if (next === 'active') schedule(0);
      else if (timer) { clearTimeout(timer); timer = null; }
    });
  }
  return () => {
    holders -= 1;
    if (holders > 0) return;
    if (timer) { clearTimeout(timer); timer = null; }
    appStateSub?.remove();
    appStateSub = null;
  };
}

/** The store as a hook. Mounting any consumer keeps the poll alive. */
export function useAgentAttention(): AttentionState {
  const snapshot = useSyncExternalStore(subscribeAttention, getAttention, getAttention);
  useEffect(() => startAttentionPolling(), []);
  return snapshot;
}
