// Reading a session Claude Code is running WITHOUT Belay — the "watch from
// the phone" half of the agent tab. Two surfaces over the same file:
//
//   GET /agent/discovered/:id/transcript?after=<byteOffset>
//       one window of events (the tail, or everything after `after`), plus
//       where to ask from next and whether the terminal is still driving.
//   /ws/transcript?session=<id>
//       hello with the tail, then a frame per growth, then `live` flips —
//       the feed the read-only TranscriptView renders.
//
// Both refuse anything that is not a session uuid and anything whose cwd is
// outside the allowed roots, with the same messages attach uses: watching a
// transcript reveals as much as taking it over would, so the gates match.
// Nothing here writes, spawns, or resumes; taking over goes through
// /agent/attach like before.

import type { Express, Request, RequestHandler, Response } from 'express';
import type { WebSocket } from 'ws';
import { SESSION_ID, attachedClaudeIds, resolveSessionCwd } from './agent.js';
import { sessionIndex } from './discover.js';
import type { LiveDiscoveredSession } from './session-index.js';
import { messageOf } from './errors.js';
import { HISTORY_CAP, readTranscriptWindow } from './transcript.js';
import type { TranscriptWindow } from './transcript.js';
import { tailTranscript } from './transcript-tail.js';
import type { TailReader } from './transcript-tail.js';

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function statusOf(e: unknown): number {
  return e instanceof RouteError ? e.status : 500;
}

interface Located {
  readonly row: LiveDiscoveredSession;
  readonly file: string;
}

/**
 * Find a discovered session by id and clear it through the cwd gate. Throws
 * a RouteError the callers map to a status.
 */
function locate(id: string): Located {
  if (!SESSION_ID.test(id)) throw new RouteError(400, 'claudeSessionId is not a session uuid');
  if (attachedClaudeIds().has(id)) throw new RouteError(409, 'session is attached — read it over /ws/agent');
  const index = sessionIndex();
  const row = index.get(id);
  const file = index.fileOf(id);
  if (!row || !file) throw new RouteError(404, 'no such session');
  try { resolveSessionCwd(row.cwd); }
  catch (e: unknown) { throw new RouteError(400, messageOf(e)); }
  return { row, file };
}

/** `after` from the query: a non-negative integer, or undefined (= the tail). */
export function parseAfter(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new RouteError(400, 'after must be a non-negative byte offset');
  return n;
}

export function registerTranscriptRoutes(app: Express, auth: RequestHandler): void {
  app.get('/agent/discovered/:id/transcript', auth, (req: Request, res: Response) => {
    try {
      const { row, file } = locate(String(req.params.id));
      const after = parseAfter(req.query.after);
      const win = readTranscriptWindow(file, after, after === undefined ? HISTORY_CAP : undefined);
      res.json({ events: win.events, offset: win.offset, live: row.live, lastWriteAt: row.lastWriteAt });
    } catch (e: unknown) {
      res.status(statusOf(e)).json({ error: messageOf(e) });
    }
  });
}

/**
 * index.ts's upgrade handler for /ws/transcript. Frames:
 *   { type:'hello', session:{ claudeSessionId, cwd, preview }, events, offset, live, lastWriteAt }
 *   { type:'events', events, offset, live, lastWriteAt }   on growth
 *   { type:'live', live, lastWriteAt }                     when only the flag moved
 *   { type:'error', error }                                then close
 */
export function handleTranscriptSocket(ws: WebSocket, url: URL): void {
  const id = url.searchParams.get('session') || '';
  let located: Located;
  try { located = locate(id); }
  catch (e: unknown) {
    ws.send(JSON.stringify({ type: 'error', error: messageOf(e) }));
    ws.close();
    return;
  }
  const { row, file } = located;
  const index = sessionIndex();
  const send = (frame: object): void => {
    try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); } catch { /* closing */ }
  };
  const liveOf = (): { live: boolean; lastWriteAt: number } => {
    const now = index.get(id);
    return now ? { live: now.live, lastWriteAt: now.lastWriteAt } : { live: false, lastWriteAt: row.lastWriteAt };
  };

  let first: TranscriptWindow;
  try { first = readTranscriptWindow(file, undefined, HISTORY_CAP); }
  catch (e: unknown) {
    send({ type: 'error', error: messageOf(e) });
    ws.close();
    return;
  }
  let lastLive = row.live;
  send({
    type: 'hello',
    session: { claudeSessionId: row.claudeSessionId, cwd: row.cwd, preview: row.preview },
    events: first.events, offset: first.offset, ...liveOf(),
  });

  let tail: TailReader | null = tailTranscript(file, first.offset, () => {
    // The index has its own watcher, but nudge it so `live` on this frame is
    // already true for the very write that produced it.
    index.touch(file);
    let win: TranscriptWindow;
    try { win = tail?.next() ?? first; } catch { return; }
    if (win.events.length === 0) return;
    // A file that just grew is live by definition; the index's own debounced
    // read confirms it a beat later and drives the eventual flip to quiet.
    lastLive = true;
    send({ type: 'events', events: win.events, offset: win.offset, live: true, lastWriteAt: Date.now() });
  });

  const unhook = index.onChange(() => {
    const l = liveOf();
    if (l.live === lastLive) return;
    lastLive = l.live;
    send({ type: 'live', ...l });
  });

  // Read-only channel: anything the client says is ignored, not an error.
  ws.on('message', () => {});
  ws.on('close', () => {
    unhook();
    tail?.close();
    tail = null;
  });
}
