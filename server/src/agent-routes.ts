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
  answerApprovalScoped, cancelQueuedPrompt, interruptSession, listGrants, revokeGrant,
} from './agent.js';


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
}
