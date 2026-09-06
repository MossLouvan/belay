// The `/ws/transcript` socket for one terminal-started session — read-only.
//
// Opens with a single-use ticket (see `wsUrl`) and folds every frame through
// the pure reducer in `transcript-model.ts`. The phone says nothing back on
// this socket; taking the session over is a separate REST call (attach) that
// the view makes once the terminal has gone quiet.

import { useCallback, useEffect, useReducer, useState } from 'react';
import { wsUrl } from '../api';
import { INITIAL_TRANSCRIPT, parseTranscriptMessage, reduceTranscript } from './transcript-model';
import type { TranscriptState } from './transcript-model';

export interface TranscriptStream extends TranscriptState {
  reconnect: () => void;
}

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

export function useTranscriptStream(claudeSessionId: string): TranscriptStream {
  const [state, dispatch] = useReducer(reduceTranscript, INITIAL_TRANSCRIPT);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    dispatch({ type: 'link', link: 'connecting' });

    const open = async (): Promise<void> => {
      let opened: WebSocket;
      try {
        opened = new WebSocket(await wsUrl('/ws/transcript', { session: claudeSessionId }));
      } catch (e: unknown) {
        if (cancelled) return;
        dispatch({ type: 'link', link: 'error' });
        dispatch({ type: 'note', note: messageOf(e, 'could not open the transcript') });
        return;
      }
      if (cancelled) { opened.close(); return; }
      socket = opened;

      opened.onmessage = (event: MessageEvent) => {
        const message = parseTranscriptMessage(event.data);
        if (message) dispatch({ type: 'message', message });
      };
      opened.onerror = () => {
        dispatch({ type: 'link', link: 'error' });
        dispatch({ type: 'note', note: 'the transcript connection failed' });
      };
      opened.onclose = () => {
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
    };
  }, [claudeSessionId, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, reconnect };
}
