// The /ws/cursors client: everyone else's pointer, and ours on the way out.
//
// Socket lifecycle follows agent/attention-store.ts — generation-guarded, one
// retry timer, never stacked — with one addition: this channel sends as well as
// receives, and the outbound half is throttled. A finger dragging across the
// screen produces move events far faster than the 20 Hz the host broadcasts at,
// and shipping every one of them would spend the uplink on pointer noise.
//
// A host too old to serve /ws/cursors closes the socket immediately. That is a
// silent, complete no-op here: no cursors, no error surface, and the Screen tab
// behaves exactly as it did before this feature existed.

import { useEffect, useRef, useState } from 'react';

import { getConnection, wsUrl } from '../api';
import { parseCursorMessage } from './cursors';
import type { RemoteCursor } from './cursors';

/** Outbound rate. Matches the host's broadcast cadence — sending faster than
 *  the room is told is pure waste. */
export const CURSOR_SEND_MS = 50;

/** How long to wait before rebuilding a socket that dropped. */
const RETRY_MS = 4_000;

export interface CursorSurface {
  readonly screen?: number;
  readonly window?: string;
}

export interface CursorsState {
  /** Everyone the host is broadcasting, us included — filter with
   *  `visibleCursors`, which needs `selfId` anyway. */
  readonly cursors: readonly RemoteCursor[];
  /** Our own id, once the host's hello arrives. Null until then. */
  readonly selfId: string | null;
  /** The colour the host assigned us, for the app's own pointer. */
  readonly selfColor: string | null;
  /** True while the channel is live. */
  readonly connected: boolean;
}

const EMPTY: CursorsState = {
  cursors: [], selfId: null, selfColor: null, connected: false,
};

/**
 * Join the cursor channel for as long as the Screen tab is mounted.
 *
 * Returns the room plus a `send` that reports where this user is pointing.
 * `send` is safe to call from a gesture handler at whatever rate the gesture
 * fires; it coalesces internally and drops everything while the socket is down.
 */
export function useRemoteCursors(enabled: boolean = true): CursorsState & {
  send: (x: number, y: number, surface?: CursorSurface) => void;
} {
  const [state, setState] = useState<CursorsState>(EMPTY);
  const socketRef = useRef<WebSocket | null>(null);
  // The latest un-sent position, and when we last flushed one.
  const pendingRef = useRef<{ x: number; y: number; surface?: CursorSurface } | null>(null);
  const lastSentRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !getConnection()) { setState(EMPTY); return undefined; }

    // Every async step below re-checks this generation before touching state:
    // a tab switch during the `await wsUrl(...)` must not adopt the socket it
    // was in the middle of opening.
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const open = async (): Promise<void> => {
      if (!live || socketRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(await wsUrl('/ws/cursors'));
      } catch {
        // No ticket, no route (an older host), no network. Cursors are an
        // enhancement: retry quietly and never surface an error for them.
        if (live) retryTimer = setTimeout(() => { void open(); }, RETRY_MS);
        return;
      }
      if (!live) { try { ws.close(); } catch { /* never opened */ } return; }
      socketRef.current = ws;

      ws.onopen = () => {
        if (socketRef.current !== ws) return;
        setState((s) => ({ ...s, connected: true }));
      };

      ws.onmessage = (event: MessageEvent) => {
        if (socketRef.current !== ws) return;
        const msg = parseCursorMessage(String(event.data));
        if (!msg) return;
        if (msg.kind === 'hello') {
          setState((s) => ({ ...s, selfId: msg.id, selfColor: msg.color }));
        } else {
          setState((s) => ({ ...s, cursors: msg.cursors }));
        }
      };

      ws.onerror = () => { /* onclose follows and owns recovery */ };

      ws.onclose = () => {
        if (socketRef.current !== ws) return;
        socketRef.current = null;
        // Drop the room rather than leaving stale cursors frozen on screen —
        // a cursor that has stopped updating is worse than no cursor.
        setState((s) => ({ ...s, cursors: [], connected: false }));
        if (live) retryTimer = setTimeout(() => { void open(); }, RETRY_MS);
      };
    };

    void open();

    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) { try { ws.close(); } catch { /* already gone */ } }
      setState(EMPTY);
    };
  }, [enabled]);

  const flush = (): void => {
    flushTimerRef.current = null;
    const next = pendingRef.current;
    const ws = socketRef.current;
    pendingRef.current = null;
    if (!next || !ws || ws.readyState !== 1) return;
    lastSentRef.current = Date.now();
    try {
      ws.send(JSON.stringify({ type: 'move', ...next.surface, x: next.x, y: next.y }));
    } catch { /* the close handler owns recovery */ }
  };

  const send = (x: number, y: number, surface?: CursorSurface): void => {
    pendingRef.current = { x, y, surface };
    if (flushTimerRef.current !== null) return;
    const wait = Math.max(0, CURSOR_SEND_MS - (Date.now() - lastSentRef.current));
    // Trailing-edge throttle: the last position of a fast drag is the one that
    // matters, and it always gets sent.
    flushTimerRef.current = setTimeout(flush, wait);
  };

  return { ...state, send };
}
