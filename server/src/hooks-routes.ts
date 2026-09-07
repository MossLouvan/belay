// The HTTP surface for terminal-session hooks. Two sides, two trust models:
//
//   POST /hooks/:event        — hooks/belay-hook.mjs, loopback only, secret
//                               header. A PermissionRequest is held open until
//                               the phone decides or the wait runs out.
//   GET  /agent/hooks         — the phone (bearer auth): every ask and notice.
//   POST /agent/hooks/:id/decide, /dismiss — the phone answers.
//
// The one rule that shapes everything here: while a PermissionRequest hook
// runs, Claude Code shows a spinner instead of its own prompt. So the host
// must only hold the hook open when a phone can actually answer — otherwise
// it says "no decision" at once and the terminal prompt appears as if Belay
// were not there. Nothing here ever answers "allow" on its own.
//
// Deps are injected (store, phone count, session ownership, clock) so the
// tests drive a real express app without a session or a websocket.

import { basename } from 'node:path';
import type { Express, Request, RequestHandler, Response } from 'express';

import { productEnv } from './env.js';
import { decisionOutput } from './hooks-store.js';
import type { HooksStore } from './hooks-store.js';
import { HOOK_SECRET_HEADER, secretMatches } from './hooks-secret.js';
import { validateHookDecisionBody, validateHookPayload } from './hooks-validate.js';
import type { PermissionRequestEvent, StopEvent } from './hooks-validate.js';
import type { NotifyEvent } from './notify.js';

/** How long the host holds a PermissionRequest open for the phone, by default. */
export const DEFAULT_HOOK_WAIT_MS = 120_000;
const MIN_HOOK_WAIT_MS = 5_000;
// Claude Code's own default hook timeout is 600s; the install writes a
// timeout above our wait, but never rely on being close to the ceiling.
const MAX_HOOK_WAIT_MS = 570_000;
const DEFAULT_PHONE_POLL_MS = 2_000;

/** A response header the hook echoes to stderr — why the host answered as it did. */
export const HOOK_REASON_HEADER = 'x-belay-hook';

export interface HookRouteDeps {
  readonly store: HooksStore;
  readonly secret: string;
  /** Phones on /ws/attention right now. Zero means "nobody can answer". */
  readonly phones: () => number;
  /** Sessions Belay itself spawned answer through the MCP sidecar, not here. */
  readonly isBelaySession: (sessionId: string) => boolean;
  readonly waitMs: number;
  readonly onSessionStart?: () => void;
  readonly notify?: (ev: NotifyEvent) => void;
  readonly hostLabel?: () => string;
  readonly hostId?: () => string;
  /** How often the wait re-checks that a phone is still connected. */
  readonly phonePollMs?: number;
}

/** BELAY_HOOK_WAIT_MS, clamped to something Claude Code's hook timeout can hold. */
export function hookWaitMs(raw: string | undefined = productEnv('HOOK_WAIT_MS')): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_HOOK_WAIT_MS;
  return Math.min(MAX_HOOK_WAIT_MS, Math.max(MIN_HOOK_WAIT_MS, Math.floor(n)));
}

const isLoopback = (ip: string | undefined): boolean =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** "belay" for /Users/me/projects/belay — the title the push and the card use. */
export function projectTitle(cwd: string): string {
  return basename(cwd) || cwd;
}

function approvalPing(deps: HookRouteDeps, event: PermissionRequestEvent, detail: string, expiresAt: number): void {
  deps.notify?.({
    kind: 'approval',
    host: deps.hostLabel?.() ?? '',
    hostId: deps.hostId?.() ?? '',
    session: { id: event.sessionId, title: projectTitle(event.cwd) },
    tool: event.toolName,
    detail,
    expiresAt,
  });
}

function donePing(deps: HookRouteDeps, event: StopEvent): void {
  if (event.stopHookActive) return;
  deps.notify?.({
    kind: 'done',
    host: deps.hostLabel?.() ?? '',
    hostId: deps.hostId?.() ?? '',
    session: { id: event.sessionId, title: projectTitle(event.cwd) },
    ok: true,
  });
}

/**
 * Hold the hook's request open until the phone decides, the wait runs out,
 * every phone disconnects, or the hook itself goes away. Each of those ends
 * in exactly one response; the store's promise settles once.
 */
function holdPermission(req: Request, res: Response, event: PermissionRequestEvent, deps: HookRouteDeps): void {
  const { item, decision } = deps.store.raise(event, deps.waitMs);
  approvalPing(deps, event, item.detail, item.expiresAt);
  let reason = 'decided';
  const withdraw = (why: string): void => { reason = why; deps.store.withdraw(item.id); };
  const timer = setTimeout(() => withdraw('wait-expired'), deps.waitMs);
  timer.unref?.();
  const watch = setInterval(() => { if (deps.phones() === 0) withdraw('phone-left'); }, deps.phonePollMs ?? DEFAULT_PHONE_POLL_MS);
  watch.unref?.();
  // The response's close, not the request's: since Node 16 a request emits
  // 'close' once its body has been read, which is long before the hook
  // process goes anywhere. The response closes only with the connection.
  res.on('close', () => { if (!res.writableEnded) withdraw('hook-closed'); });
  void decision.then((d) => {
    clearTimeout(timer);
    clearInterval(watch);
    if (res.writableEnded || res.destroyed) return;
    res.setHeader(HOOK_REASON_HEADER, reason);
    res.json(decisionOutput(d));
  });
}

function hookGuard(deps: HookRouteDeps): RequestHandler {
  return (req, res, next) => {
    if (!isLoopback(req.socket.remoteAddress)) { res.status(403).json({ error: 'loopback only' }); return; }
    if (!secretMatches(req.get(HOOK_SECRET_HEADER), deps.secret)) { res.status(401).json({ error: 'bad hook secret' }); return; }
    next();
  };
}

function handleHook(deps: HookRouteDeps): RequestHandler {
  return (req, res) => {
    const parsed = validateHookPayload(req.body);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const event = parsed.event;
    if (event.kind !== req.params.event) { res.status(400).json({ error: 'event name does not match payload' }); return; }
    const noDecision = (why: string): void => { res.setHeader(HOOK_REASON_HEADER, why); res.json({}); };
    switch (event.kind) {
      case 'PermissionRequest':
        if (deps.isBelaySession(event.sessionId)) { noDecision('belay-session'); return; }
        if (deps.phones() === 0) { noDecision('no-phone'); return; }
        holdPermission(req, res, event, deps);
        return;
      case 'Stop':
        deps.store.notice(event);
        donePing(deps, event);
        noDecision('noted');
        return;
      case 'Notification':
        deps.store.notice(event);
        noDecision('noted');
        return;
      case 'SessionStart':
        deps.onSessionStart?.();
        noDecision('noted');
        return;
    }
  };
}

export function registerHookRoutes(app: Express, auth: RequestHandler, deps: HookRouteDeps): void {
  app.post('/hooks/:event', hookGuard(deps), handleHook(deps));

  app.get('/agent/hooks', auth, (_req: Request, res: Response) => {
    res.json({ permissions: deps.store.pending(), notices: deps.store.notices() });
  });

  // The grant, if any, is minted server-side from the suggestion Claude Code
  // sent; the wire only names which offered choice was tapped.
  app.post('/agent/hooks/:id/decide', auth, (req: Request, res: Response) => {
    const body = validateHookDecisionBody(req.body);
    if (!body.ok) { res.status(400).json({ error: body.error }); return; }
    res.json({ ok: deps.store.decide(req.params.id, body.allow, body.choiceId) });
  });

  app.post('/agent/hooks/:id/dismiss', auth, (req: Request, res: Response) => {
    res.json({ ok: deps.store.dismiss(req.params.id) });
  });
}
