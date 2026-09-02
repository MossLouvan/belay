// REST surface for phone-to-session images. Written here and registered by
// index.ts with one call, the same shape as recording-routes.ts.
//
// The upload body is base64 text under its own content type, not JSON: the
// global JSON parser is capped at 2 MB (right for every other route, far too
// small for a photo), and React Native's fetch cannot carry raw binary
// bodies reliably — base64 text is the one encoding both ends handle without
// ceremony. The parser below is scoped to this route alone, so the tight
// global cap keeps protecting everything else.
//
// As with recordings, the one piece of orchestration that belongs here is the
// handoff — staged images plus a session id become files in that session's
// project and a prompt in that session's queue — because this is the only
// module that may know about both the drop and the agent.

import { messageOf } from './errors.js';
import express from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';

import { getSnapshot, sendPrompt } from './agent.js';
import { IMAGES, imageDrop } from './images.js';


// 12 MB of image is 16 MB of base64; a little slack for whitespace a client
// may interleave. Anything bigger is refused by the parser before this
// process ever holds it whole.
const BASE64_BODY_LIMIT = Math.ceil((IMAGES.maxImageBytes * 4) / 3) + 64 * 1024;

const base64Body = express.text({ type: 'application/base64', limit: BASE64_BODY_LIMIT });

/** Reject anything that is not plausibly base64 before Buffer.from silently skips the junk. */
const BASE64_SHAPE = /^[A-Za-z0-9+/=\s]+$/;

export function registerImageRoutes(app: Express, auth: RequestHandler): void {
  // Stage one image. Called once per picked photo; the batch is committed by
  // /images/send or dropped by /images/discard (or expires on its own).
  app.post('/images/add', auth, base64Body, (req: Request, res: Response) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (body.length === 0 || !BASE64_SHAPE.test(body)) {
      res.status(400).json({ error: 'the image upload was not base64' });
      return;
    }
    try {
      res.json(imageDrop.add(Buffer.from(body, 'base64')));
    } catch (e: unknown) {
      const message = messageOf(e);
      res.status(/too large/.test(message) ? 413 : 400).json({ error: message });
    }
  });

  app.post('/images/discard', auth, (_req: Request, res: Response) => {
    res.json(imageDrop.discard());
  });

  // The handoff: photos land inside the session's own project (the one place
  // Claude Code reads by bare relative path), then the prompt referencing
  // them is queued on that session — the exact contract /recording/send keeps.
  app.post('/images/send', auth, async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || '');
    const snap = getSnapshot(sessionId);
    if (!snap) { res.status(404).json({ error: 'no such session' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : undefined;
    try {
      const delivery = await imageDrop.deliver(snap.cwd, note);
      sendPrompt(sessionId, delivery.prompt);
      res.json({ ok: true, dir: delivery.dir, relDir: delivery.relDir, files: delivery.files.length });
    } catch (e: unknown) {
      res.status(400).json({ error: messageOf(e) });
    }
  });
}
