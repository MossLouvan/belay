// The handoff request, colocated with the feature exactly as changes-api.ts
// is: the response shape lives and evolves with the handoff screen, and
// api.ts's private fetch helpers are not exported. Same transport rules —
// bearer header, hard deadline, abort not abandon.

import { getConnection, REQUEST_TIMEOUT_MS, TimeoutError, UnauthorizedError } from '../api';
import { parseHandoff } from './handoff-model';
import type { HandoffOutcome } from './handoff-model';

/**
 * Ask the host to open this session in a terminal on the computer.
 * `stop: true` is the user's explicit consent to interrupt a session the
 * phone is still driving — never send it without having asked them.
 */
export async function requestHandoff(sessionId: string, stop: boolean): Promise<HandoffOutcome> {
  const conn = getConnection();
  if (!conn) throw new Error('not connected');
  const path = `/agent/sessions/${encodeURIComponent(sessionId)}/handoff`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(conn.host + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(stop ? { stop: true } : {}),
      signal: controller.signal,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new TimeoutError(path);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new UnauthorizedError();
  const body: unknown = await res.json().catch(() => ({}));
  return parseHandoff(res.status, body);
}
