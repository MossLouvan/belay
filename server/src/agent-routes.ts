// The REST surface for scoped approvals and the prompt queue, written here
// and registered by index.ts with one call — the same arrangement as
// recording-routes.ts, so new agent abilities ship without touching the
// routing file's own history. Everything here is bearer-authed like the rest
// of the agent routes; the phone reaches these when its websocket cannot
// carry the answer (the socket's message vocabulary lives in index.ts and
// predates scopes, queues and interrupts).

import { messageOf } from './errors.js';
import type { Express, Request, RequestHandler, Response } from 'express';

import {
  answerApprovalScoped, cancelQueuedPrompt, getSnapshot, interruptSession, listGrants,
  revokeGrant, sendPrompt,
} from './agent.js';
import { ImageDrop } from './images.js';
import { native } from './native.js';
import { screenIndexOf } from './stream-params.js';


// ---- send-screen: a one-shot grab of the host's display, into the session --
//
// The phone asks; the pixels never leave this machine. That is the whole
// point — the display Claude should look at and the disk Claude reads from
// are the same computer, so round-tripping a JPEG through cellular would add
// bytes, seconds and a lossy hop to a pipeline whose producer and consumer
// share a disk. The phone sends one small request and gets counters back,
// exactly the recorder's contract.
//
// Delivery reuses ImageDrop — sniffing, confinement, naming, pruning — so
// this second write surface cannot become a second, subtly different sandbox.
// Only the prompt is this route's own: a screenshot of the host is a
// different sentence than "photos from my phone".

/**
 * One frame, not thirty a second, so it can afford what the live stream
 * cannot: full capture width and a quality where menu text survives JPEG.
 */
export const SCREENSHOT = Object.freeze({
  width: 1920,
  quality: 75,
} as const);

/**
 * The prompt handed to Claude alongside the grab. Same skeleton as the photo
 * and recording prompts: where the file is (relative, inside the session's
 * own project), the user's note where the task goes, and the reminder not to
 * commit capture debris.
 */
export function buildScreenshotPrompt(args: {
  readonly relDir: string;
  readonly fileName: string;
  readonly note?: string;
}): string {
  const { relDir, fileName, note } = args;
  const ask = note?.trim()
    ? note.trim()
    : 'describe what is on the screen and how it relates to what we are working on.';
  return [
    `I'm sending a screenshot of this computer's current display, taken just now, saved at ${relDir}/${fileName} inside this project.`,
    `Look at it, then: ${ask}`,
    'The file is a throwaway capture — do not commit it.',
  ].join('\n\n');
}


export function registerAgentApprovalRoutes(app: Express, auth: RequestHandler): void {
  // Like /approve, but `choice` names one of the scope choices the card
  // offered; the grant is minted server-side from the pending ask itself, so
  // the wire cannot request a wider scope than was shown.
  app.post('/agent/sessions/:id/approve-scoped', auth, (req: Request, res: Response) => {
    const { approvalId, allow, choice } = req.body || {};
    const ok = answerApprovalScoped(
      req.params.id, String(approvalId || ''), !!allow,
      typeof choice === 'string' && choice ? choice : undefined,
    );
    res.json({ ok });
  });

  app.get('/agent/sessions/:id/grants', auth, (req: Request, res: Response) => {
    const grants = listGrants(req.params.id);
    if (!grants) { res.status(404).json({ error: 'no such session' }); return; }
    res.json({ grants });
  });

  app.post('/agent/sessions/:id/grants/revoke', auth, (req: Request, res: Response) => {
    const grantId = String(req.body?.grantId || '');
    if (!grantId) { res.status(400).json({ error: 'a grantId is required' }); return; }
    res.json({ ok: revokeGrant(req.params.id, grantId) });
  });

  app.post('/agent/sessions/:id/queue/cancel', auth, (req: Request, res: Response) => {
    try { res.json({ ok: cancelQueuedPrompt(req.params.id) }); }
    catch (e: unknown) { res.status(400).json({ error: messageOf(e) }); }
  });

  // Interrupt-with-message: deliberately a different route from /prompt, so
  // "queue it for later" and "halt the turn for this" can never be confused
  // by a stale client or a retried request.
  app.post('/agent/sessions/:id/interrupt', auth, (req: Request, res: Response) => {
    try { res.json({ ok: true, outcome: interruptSession(req.params.id, String(req.body?.text || '')) }); }
    catch (e: unknown) { res.status(400).json({ error: messageOf(e) }); }
  });

  // "Why is this dialog stuck?" from the couch: capture the host's display
  // right now, land the JPEG inside this session's project, queue the prompt
  // referencing it. A fresh ImageDrop per request keeps the grab fully apart
  // from any phone-photo batch the shared drop is staging at the same moment.
  app.post('/agent/sessions/:id/screenshot', auth, async (req: Request, res: Response) => {
    const snap = getSnapshot(req.params.id);
    if (!snap) { res.status(404).json({ error: 'no such session' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : undefined;

    let frame;
    try {
      // The helper may have crashed since boot; starting it here means the
      // grab captures rather than failing on a dead pipe first.
      await native.start();
      frame = await native.capture(
        SCREENSHOT.width, SCREENSHOT.quality, false, screenIndexOf(req.body?.screen),
      );
    } catch (e: unknown) {
      res.status(409).json({ error: messageOf(e) });
      return;
    }

    try {
      const drop = new ImageDrop();
      drop.add(Buffer.from(frame.data, 'base64'));
      const delivery = await drop.deliver(snap.cwd);
      sendPrompt(req.params.id, buildScreenshotPrompt({
        relDir: delivery.relDir, fileName: delivery.files[0], note,
      }));
      res.json({ ok: true, relDir: delivery.relDir, file: delivery.files[0] });
    } catch (e: unknown) {
      res.status(400).json({ error: messageOf(e) });
    }
  });
}
