// Drives the host-side screen recorder from the Screen tab.
//
// The recording never touches the phone: frames are captured, kept and — on
// send — written to disk on the computer itself, next to the Claude session
// that will read them. This hook only moves the recorder's state machine and
// mirrors its counters, polling `/recording/status` once a second while a
// recording runs so the strip's clock is the host's clock, not an optimistic
// local timer that keeps counting after the host has died.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getConnection, TimeoutError } from '../api';
import { IDLE_RECORDING, RECORD_POLL_MS, parseRecordingStatus } from './record';
import type { RecordingStatus } from './record';

/** Same request deadline as the api module's REST helpers. */
const TIMEOUT_MS = 10_000;

async function call(path: string, body?: object): Promise<RecordingStatus> {
  const conn = getConnection();
  if (!conn) throw new Error('not connected');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(conn.host + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${conn.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (json as { error?: string })?.error;
      throw new Error(message || `request failed (${res.status})`);
    }
    return parseRecordingStatus(json);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new TimeoutError(path);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface SendResult {
  readonly frames: number;
  readonly relDir: string;
}

export interface RecordingControl {
  readonly status: RecordingStatus;
  readonly busy: boolean;
  readonly start: (screen?: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly discard: () => Promise<void>;
  readonly send: (sessionId: string, note?: string) => Promise<SendResult>;
}

/**
 * @param active Paired and focused, the same gate the stream uses. A
 *   recording deliberately OUTLIVES the gate — leaving the tab must not kill
 *   a capture the user started on purpose — so going inactive only stops the
 *   polling; the next focus re-reads the host's status and the strip picks
 *   the recording back up mid-count.
 * @param onError One-shot failures go to the tab's shared toast.
 */
export function useRecording(active: boolean, onError: (message: string) => void): RecordingControl {
  const [status, setStatus] = useState<RecordingStatus>(IDLE_RECORDING);
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!active) return;
    let disposed = false;

    const probe = async (): Promise<void> => {
      try {
        const next = await call('/recording/status');
        if (!disposed) setStatus(next);
      } catch {
        // A missed poll is not an event; the next one, or the next action,
        // will tell the truth. Erroring here would toast once a second.
      }
    };

    void probe();
    const timer = setInterval(() => {
      if (statusRef.current.state === 'recording') void probe();
    }, RECORD_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active]);

  const run = useCallback(
    async (label: string, path: string, body: object): Promise<void> => {
      setBusy(true);
      try {
        setStatus(await call(path, body));
      } catch (e: unknown) {
        onError(`${label} — ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onError],
  );

  const start = useCallback(
    (screen?: number) =>
      run('Recording could not start', '/recording/start', screen === undefined ? {} : { screen }),
    [run],
  );
  const stop = useCallback(() => run('Recording could not stop', '/recording/stop', {}), [run]);
  const discard = useCallback(() => run('Discard failed', '/recording/discard', {}), [run]);

  // Send does NOT route errors to the toast: the sheet that calls it shows
  // the failure next to its own Send control, where the retry lives.
  const send = useCallback(async (sessionId: string, note?: string): Promise<SendResult> => {
    const conn = getConnection();
    if (!conn) throw new Error('not connected');
    setBusy(true);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(conn.host + '/recording/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, ...(note?.trim() ? { note: note.trim() } : {}) }),
          signal: controller.signal,
        });
        const json: unknown = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string })?.error || `request failed (${res.status})`);
        setStatus(IDLE_RECORDING);
        const reply = json as { frames?: number; relDir?: string };
        return { frames: reply.frames ?? 0, relDir: reply.relDir ?? '' };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, start, stop, discard, send };
}
