// HTTP for account trust (account-pair.ts decides everything):
//
//   POST   /pair/account          tunnel phone asks → 200 token (first phone,
//                                 inside the window), 202 {pendingId,
//                                 pollSecret, matchCode}, 403 or 429
//   GET    /pair/account/:id      the asking phone polls, quoting its poll
//                                 secret in X-Belay-Poll-Secret → pending |
//                                 approved (token, once) | 403 denied | 404
//   DELETE /pair/account/:id      the asking phone gives up (same header)
//   POST   /devices/approve       a paired phone taps Allow or Deny (authed)
//
// Every reply is about the caller's own request only: no other phone's name,
// node or count ever leaves here.

import type { Express, Request, RequestHandler } from 'express';

import type { AccountPairing } from './account-pair.js';

export const POLL_SECRET_HEADER = 'x-belay-poll-secret';

export interface AccountPairRouteDeps {
  readonly pairing: AccountPairing;
  readonly allowList: () => readonly string[];
  readonly linked: () => boolean;
  readonly deviceCount: () => number;
  /** The persisted first-phone deadline (state.ts); 0 when closed. */
  readonly trustUntil: () => number;
  /** What the account says about a phone node (heartbeat), if anything. */
  readonly phoneInfo?: (nodeId: string) => { platform: string; createdAt: number } | undefined;
  /** Mint a device (closing the first-phone window) and return the /pair body. Must be synchronous. */
  readonly issue: (name: string) => Record<string, unknown>;
  /** pairRefusal: browsers may not drive this route. */
  readonly refusal?: (headers: Record<string, unknown>) => { status: number; error: string } | null;
}

const pollSecret = (req: Request): string => {
  const v = req.headers[POLL_SECRET_HEADER];
  return typeof v === 'string' ? v : '';
};

export function registerAccountPairRoutes(app: Express, auth: RequestHandler, deps: AccountPairRouteDeps): void {
  const { pairing } = deps;
  const who = (req: Request) => ({ remoteAddress: req.socket.remoteAddress, allowList: deps.allowList(), linked: deps.linked() });

  app.post('/pair/account', (req, res) => {
    const refused = deps.refusal?.(req.headers);
    if (refused) { res.status(refused.status).json({ error: refused.error }); return; }
    const remote = req.socket.remoteAddress ?? '';
    const node = remote.startsWith('tunnel:') ? remote.slice('tunnel:'.length) : '';
    const d = pairing.request({
      ...who(req),
      deviceCount: deps.deviceCount(),
      trustUntil: deps.trustUntil(),
      name: req.body?.deviceName,
      info: node ? deps.phoneInfo?.(node) : undefined,
    });
    if (d.kind === 'refused') {
      if (d.status === 429) res.set('Retry-After', String(d.retryAfterSec));
      res.status(d.status).json({ error: d.error, retryAfterSec: d.retryAfterSec });
      return;
    }
    // No await between the decision and the mint: the next request must
    // already count this device, or two phones could both be "the first".
    if (d.kind === 'trusted') { res.json({ ...deps.issue(d.name), via: 'account' }); return; }
    res.status(202).json({
      status: 'pending', pendingId: d.id, pollSecret: d.secret, matchCode: d.matchCode,
      expiresInSec: Math.ceil((d.expiresAt - Date.now()) / 1000),
    });
  });

  app.get('/pair/account/:id', (req, res) => {
    const p = pairing.poll(String(req.params.id), pollSecret(req), who(req));
    if (p.status === 'pending') {
      res.json({ status: 'pending', matchCode: p.matchCode, expiresInSec: Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000)) });
      return;
    }
    if (p.status === 'denied') { res.status(403).json({ status: 'denied', error: 'the request to add this phone was declined' }); return; }
    if (p.status === 'unknown') { res.status(404).json({ status: 'expired', error: 'that request expired; ask again' }); return; }
    res.json({ ...deps.issue(p.name), status: 'approved', via: 'account' });
  });

  app.delete('/pair/account/:id', (req, res) => {
    if (pairing.cancel(String(req.params.id), pollSecret(req), req.socket.remoteAddress)) res.status(204).end();
    else res.status(404).json({ error: 'no such request' });
  });

  app.post('/devices/approve', auth, (req, res) => {
    const { pendingId, allow } = req.body ?? {};
    if (typeof pendingId !== 'string' || typeof allow !== 'boolean') {
      res.status(400).json({ error: 'expected {pendingId: string, allow: boolean}' });
      return;
    }
    if (!pairing.decide(pendingId, allow, { allowList: deps.allowList(), linked: deps.linked() })) {
      res.status(404).json({ error: 'that request expired or was already answered' });
      return;
    }
    res.json({ ok: true });
  });
}
