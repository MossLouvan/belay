// The `/ws/agent-attach` socket for one pty-backed session.
//
// Everything that decides anything lives in `attach-model.ts`; this file is the
// wiring — open with a ticket, fold messages through the reducer, batch output
// into the same ANSI parser the Terminal tab uses, and re-attach when the
// socket drops so the host's scrollback replay puts the screen back.
//
// The screen buffer is owned here rather than in the view for the same reason
// the Terminal tab owns it in its screen: output arrives faster than React can
// re-render, so it is buffered and flushed on a frame budget, and only the
// flushed result is state.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { wsUrl } from '../api';
import { clearTermState, createTermState, feed } from '../terminal-ansi';
import type { TermOptions, TermState } from '../terminal-ansi';
import { EMPTY_OUTPUT, FLUSH_MS, drainOutput, pushOutput } from '../terminal-session';
import type { OutputBuffer } from '../terminal-session';
import type { Geometry } from '../terminal-geometry';
import {
  INITIAL_ATTACH, parseAttachMessage, reduceAttach, retryDelay, shouldReattach,
} from './attach-model';
import type { AttachState } from './attach-model';

/** Lines of scrollback kept on the phone, matching the Terminal tab's budget. */
const MAX_SCROLLBACK = 1500;
/** Rotation and font changes fire a burst of layouts; only the last one is news. */
const RESIZE_DEBOUNCE_MS = 200;

export interface AgentAttach {
  readonly state: AttachState;
  /** The parsed screen, ready to hand to `TerminalOutput`. */
  readonly term: TermState;
  /** Send keystrokes to the shared pty. */
  readonly send: (data: string) => void;
  /** Clear this phone's view of the screen (and redraw the real one on a pty). */
  readonly clear: () => void;
  /** Re-attach now: the button behind an exit or a refusal. */
  readonly reattach: () => void;
}

/**
 * Attach to `id` and keep attached.
 *
 * `geometry` is what this client measured; the host answers with the minimum
 * across every attached client, and that answer — not this argument — is what
 * the screen is laid out to (see `state.size`).
 */
export function useAgentAttach(id: string, geometry: Geometry): AgentAttach {
  const [state, dispatch] = useReducer(reduceAttach, INITIAL_ATTACH);
  const [term, setTerm] = useState<TermState>(createTermState);
  const [attempt, setAttempt] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const bufferRef = useRef<OutputBuffer>(EMPTY_OUTPUT);
  const geometryRef = useRef<Geometry>(geometry);
  /** The negotiated size, for the parser — which must wrap at what the pty uses. */
  const sizeRef = useRef(state.size);
  const retriesRef = useRef(0);

  geometryRef.current = geometry;
  sizeRef.current = state.size;
  retriesRef.current = state.retries;

  // This client's own measurement, kept in the state so `sizeNote` can compare
  // it with what the host granted.
  useEffect(() => {
    dispatch({ type: 'requested', size: { cols: geometry.cols, rows: geometry.rows } });
  }, [geometry.cols, geometry.rows]);

  const flush = useCallback(() => {
    const { text, next } = drainOutput(bufferRef.current);
    bufferRef.current = next;
    if (text.length === 0) return;
    const options: TermOptions = { ...sizeRef.current, maxLines: MAX_SCROLLBACK };
    setTerm((prev) => feed(prev, text, options));
  }, []);

  useEffect(() => {
    if (!id) return undefined;
    // A fresh attach replays the whole scrollback, so the previous screen must
    // go: keeping it would print the session twice, once stale.
    bufferRef.current = EMPTY_OUTPUT;
    setTerm(createTermState());
    dispatch({ type: 'link', link: 'connecting' });

    // The upgrade URL needs a ticket fetched over HTTP first, so opening is
    // asynchronous; `cancelled` covers the gap where the effect is torn down
    // while that request is still in flight.
    let cancelled = false;
    let socket: WebSocket | null = null;

    const open = async (): Promise<void> => {
      let opened: WebSocket;
      try {
        const { cols, rows } = geometryRef.current;
        opened = new WebSocket(await wsUrl('/ws/agent-attach', { id, cols, rows }));
      } catch (e: unknown) {
        if (cancelled) return;
        dispatch({
          type: 'message',
          message: { type: 'error', error: e instanceof Error ? e.message : 'could not attach to the session' },
        });
        return;
      }
      if (cancelled) { opened.close(); return; }
      socket = opened;
      wsRef.current = opened;

      opened.onmessage = (event: MessageEvent) => {
        const message = parseAttachMessage(event.data);
        if (!message) return;
        if (message.type === 'data') {
          bufferRef.current = pushOutput(bufferRef.current, message.data);
          return;
        }
        dispatch({ type: 'message', message });
      };
      // A socket-level failure is a dropped link, never a refusal: the host
      // says no in a `{type:'error'}` frame, and only that frame is a reason
      // to stop trying.
      opened.onerror = () => dispatch({ type: 'link', link: 'closed' });
      opened.onclose = () => {
        if (wsRef.current === opened) wsRef.current = null;
        dispatch({ type: 'link', link: 'closed' });
      };
    };

    void open();
    const timer = setInterval(flush, FLUSH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (!socket) return;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (wsRef.current === socket) wsRef.current = null;
    };
  }, [id, attempt, flush]);

  // Re-attach after a drop, on a backoff. The host replays the scrollback, so
  // this restores the screen rather than clearing it — which is the whole
  // reason a dead screen is never what the user is left looking at.
  useEffect(() => {
    if (!shouldReattach({ link: state.link })) return undefined;
    const t = setTimeout(() => {
      dispatch({ type: 'reopen' });
      setAttempt((n) => n + 1);
    }, retryDelay(retriesRef.current));
    return () => clearTimeout(t);
  }, [state.link]);

  // Tell the host what this client can draw. The host answers with the
  // negotiated minimum, which may be smaller — that answer lands as a `resize`.
  useEffect(() => {
    if (state.link !== 'open') return undefined;
    const t = setTimeout(() => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify({ type: 'resize', cols: geometry.cols, rows: geometry.rows }));
      } catch {
        // A socket that closed mid-debounce is handled by onclose.
      }
    }, RESIZE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [geometry.cols, geometry.rows, state.link]);

  const send = useCallback((data: string) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ type: 'data', data }));
    } catch {
      dispatch({ type: 'link', link: 'closed' });
    }
  }, []);

  const clear = useCallback(() => {
    bufferRef.current = EMPTY_OUTPUT;
    setTerm(clearTermState);
    // Ctrl+L makes the real pty redraw, so the two screens agree again.
    send('\x0c');
  }, [send]);

  const reattach = useCallback(() => {
    dispatch({ type: 'reopen', manual: true });
    setAttempt((n) => n + 1);
  }, []);

  return { state, term, send, clear, reattach };
}
