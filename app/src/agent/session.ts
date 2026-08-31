// The `/ws/agent` socket for one session.
//
// Opens with a single-use ticket (see `wsUrl`), folds every message through
// the pure reducer in `model.ts`, and exposes the three things the phone can
// say back: a prompt, an approval answer, and stop. Prompt and stop also fall
// back to REST when the socket is not open, so a flaky link never leaves a
// running session un-stoppable.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, wsUrl } from '../api';
import { INITIAL_SESSION, parseAgentMessage, reduceSession } from './model';
import type { SessionState } from './model';

export interface AgentSession extends SessionState {
  prompt: (text: string) => void;
  /**
   * Answer the pending ask. `choiceId` names one of the scope choices the
   * host offered — it travels over REST because the socket's message
   * vocabulary predates scoped grants; a plain allow/deny keeps the socket.
   */
  approve: (approvalId: string, allow: boolean, choiceId?: string) => void;
  /** Halt the running turn (or deny the pending ask) so this text steers now. */
  interrupt: (text: string) => void;
  cancelQueued: () => void;
  revokeGrant: (grantId: string) => void;
  stop: () => void;
  reconnect: () => void;
  setNote: (note: string) => void;
}

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

export function useAgentSession(id: string): AgentSession {
  const [state, dispatch] = useReducer(reduceSession, INITIAL_SESSION);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // The upgrade URL needs a ticket fetched over HTTP first, so opening is
    // asynchronous; `cancelled` covers the gap where the effect is torn down
    // while that request is still in flight.
    let cancelled = false;
    let socket: WebSocket | null = null;
    dispatch({ type: 'link', link: 'connecting' });

    const open = async (): Promise<void> => {
      let opened: WebSocket;
      try {
        opened = new WebSocket(await wsUrl('/ws/agent', { session: id }));
      } catch (e: unknown) {
        if (cancelled) return;
        dispatch({ type: 'link', link: 'error' });
        dispatch({ type: 'note', note: messageOf(e, 'could not open the session') });
        return;
      }
      if (cancelled) { opened.close(); return; }
      socket = opened;
      wsRef.current = opened;

      opened.onmessage = (event: MessageEvent) => {
        const message = parseAgentMessage(event.data);
        if (message) dispatch({ type: 'message', message });
      };
      opened.onerror = () => {
        dispatch({ type: 'link', link: 'error' });
        dispatch({ type: 'note', note: 'the session connection failed' });
      };
      opened.onclose = () => {
        if (wsRef.current === opened) wsRef.current = null;
        dispatch({ type: 'link', link: 'closed' });
      };
    };

    void open();
    return () => {
      cancelled = true;
      if (!socket) return;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (wsRef.current === socket) wsRef.current = null;
    };
  }, [id, attempt]);

  const sendJson = useCallback((payload: object): boolean => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const setNote = useCallback((note: string) => dispatch({ type: 'note', note }), []);

  const prompt = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // A busy host queues the prompt rather than refusing it, so nothing is
    // gated on status here — the composer's label says which will happen.
    setNote('');
    if (sendJson({ type: 'prompt', text: trimmed })) return;
    api.agentPrompt(id, trimmed).catch((e: unknown) => setNote(messageOf(e, 'could not send the prompt')));
  }, [id, sendJson, setNote]);

  const approve = useCallback((approvalId: string, allow: boolean, choiceId?: string) => {
    if (choiceId === undefined && sendJson({ type: 'approve', approvalId, allow, always: false })) return;
    const call = choiceId === undefined
      ? api.agentApprove(id, approvalId, allow, false)
      : api.agentApproveScoped(id, approvalId, allow, choiceId);
    call.catch((e: unknown) => setNote(messageOf(e, 'could not send the answer')));
  }, [id, sendJson, setNote]);

  const interrupt = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setNote('');
    api.agentInterrupt(id, trimmed).catch((e: unknown) => setNote(messageOf(e, 'could not interrupt the turn')));
  }, [id, setNote]);

  const cancelQueued = useCallback(() => {
    api.agentCancelQueued(id).catch((e: unknown) => setNote(messageOf(e, 'could not cancel the queued prompt')));
  }, [id, setNote]);

  const revokeGrant = useCallback((grantId: string) => {
    api.agentRevokeGrant(id, grantId).catch((e: unknown) => setNote(messageOf(e, 'could not revoke the permission')));
  }, [id, setNote]);

  const stop = useCallback(() => {
    if (sendJson({ type: 'stop' })) return;
    api.agentStop(id).catch((e: unknown) => setNote(messageOf(e, 'could not stop the session')));
  }, [id, sendJson, setNote]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, prompt, approve, interrupt, cancelQueued, revokeGrant, stop, reconnect, setNote };
}
