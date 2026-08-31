// REST surface for host-side screen recording. Written here and registered by
// index.ts with one call, so the recorder ships without touching the routing
// file's own history.
//
// The routes are thin on purpose: state and caps live in recording.ts, frame
// policy in recording-frames.ts. The one piece of orchestration that belongs
// here is the handoff — a stopped recording plus a session id becomes files in
// that session's project and a prompt in that session's queue — because this
// is the only module that may know about both the recorder and the agent.

import type { Express, Request, RequestHandler, Response } from 'express';

import { native } from './native.js';
import { getSnapshot, sendPrompt } from './agent.js';
import { recorder } from './recording.js';
import { screenIndexOf } from './stream-params.js';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerRecordingRoutes(app: Express, auth: RequestHandler): void {
  app.get('/recording/status', auth, (_req: Request, res: Response) => {
    res.json(recorder.status());
  });

  app.post('/recording/start', auth, async (req: Request, res: Response) => {
    try {
      // The helper may have crashed since boot; starting it here means the
      // recording begins capturing rather than counting ten failures first.
      await native.start();
      res.json(recorder.start(screenIndexOf(req.body?.screen)));
    } catch (e: unknown) {
      res.status(409).json({ error: messageOf(e) });
    }
  });

  app.post('/recording/stop', auth, (_req: Request, res: Response) => {
    try { res.json(recorder.stop()); }
    catch (e: unknown) { res.status(409).json({ error: messageOf(e) }); }
  });

  app.post('/recording/discard', auth, (_req: Request, res: Response) => {
    res.json(recorder.discard());
  });

  // The whole point of the feature in one route: frames land inside the
  // session's own project (the one place Claude Code reads by bare relative
  // path), then the prompt referencing them is queued on that session.
  app.post('/recording/send', auth, async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || '');
    const snap = getSnapshot(sessionId);
    if (!snap) { res.status(404).json({ error: 'no such session' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : undefined;
    try {
      const delivery = await recorder.deliver(snap.cwd, note);
      sendPrompt(sessionId, delivery.prompt);
      res.json({ ok: true, dir: delivery.dir, relDir: delivery.relDir, frames: delivery.frames.length });
    } catch (e: unknown) {
      res.status(400).json({ error: messageOf(e) });
    }
  });
}
