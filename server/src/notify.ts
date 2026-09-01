// Push notifications from the host, because the host is the piece that is
// always awake. The phone's foreground poll, tab badge and banner all die the
// moment iOS suspends the app — and the app cannot schedule a local
// notification for an approval that has not happened yet (the reasoning is
// recorded in app/src/agent/attention-store.ts). So the ping originates here:
// when Claude raises an approval (or a session errors, or optionally finishes
// a turn), the host POSTs to a webhook the user configured. ntfy is the
// documented first-class target — a plain HTTP POST, a free iOS app, and
// self-hostable so nothing leaves the user's own infrastructure — but the
// payload is generic enough for Slack, Discord, Home Assistant or anything
// with a URL.
//
// Two promises this module keeps, in order of importance:
//
// 1. A notification can never hurt a session. Delivery is fire-and-forget
//    with a short timeout; the approval was already raised and is already
//    waiting before the webhook is even attempted, and no failure — dead DNS,
//    wrong URL, hanging server — propagates anywhere. A broken webhook logs
//    once, not once per ask.
// 2. It does not leak by default. An approval's detail is a command line or a
//    file path, and command lines carry secrets. ntfy.sh — the zero-setup
//    target most people will try first — delivers to anyone who guesses the
//    topic name. So the default notification is metadata only (computer,
//    session, tool name, time left) and the one-line detail is opt-in for
//    people on a self-hosted or access-controlled endpoint.

import { productEnv } from './env.js';

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/** Long enough for a slow self-hosted ntfy, short enough to never matter. */
export const NOTIFY_TIMEOUT_MS = 5000;

/** How much of an opted-in detail line rides in a notification. */
const DETAIL_CAP = 160;

export type NotifyEventClass = 'approval' | 'done' | 'error';

// `expired` is a distinct kind (its message must read differently from a live
// ask) but belongs to the approval *class*: anyone who wanted the ask surely
// wants to know it died unanswered.
export type NotifyKind = 'approval' | 'expired' | 'done' | 'error';

export interface NotifyEvent {
  readonly kind: NotifyKind;
  /** The computer's friendly label — "which machine is asking". */
  readonly host: string;
  /** Stable machine id, so the deep link can name the right computer. */
  readonly hostId: string;
  readonly session: { readonly id: string; readonly title: string };
  readonly tool?: string;
  /** One-line summary of the tool input. Only sent when detail is opted in. */
  readonly detail?: string;
  /** Epoch ms the ask auto-denies; absent when configured to wait forever. */
  readonly expiresAt?: number;
  /** expired: how long the ask waited before being denied. */
  readonly waitedMin?: number;
  /** done: turn stats. */
  readonly ok?: boolean;
  readonly costUsd?: number;
  readonly durationMs?: number;
  /** error: a short, already-safe description (no stderr, no paths). */
  readonly text?: string;
}

export interface NotifyConfig {
  readonly enabled: boolean;
  /** Why `enabled` is false when a URL was supplied — surfaced in the banner. */
  readonly disabledReason?: string;
  readonly url: string;
  readonly format: 'ntfy' | 'json';
  readonly token: string;
  readonly includeDetail: boolean;
  readonly events: ReadonlySet<NotifyEventClass>;
}

const DEFAULT_EVENTS: readonly NotifyEventClass[] = ['approval', 'error'];

const OFF: NotifyConfig = Object.freeze({
  enabled: false, url: '', format: 'ntfy' as const, token: '', includeDetail: false,
  events: new Set(DEFAULT_EVENTS),
});

/**
 * Read the webhook config from the environment. Pure so tests can feed it
 * envs; sanitised so a typo degrades loudly (via the banner's reason) rather
 * than into a webhook that silently never fires or fires somewhere strange.
 */
export function loadNotifyConfig(env: Record<string, string | undefined> = process.env): NotifyConfig {
  const raw = (productEnv('NOTIFY_URL', env) || '').trim();
  if (!raw) return OFF;

  let url: URL;
  try { url = new URL(raw); }
  catch { return { ...OFF, disabledReason: 'BELAY_NOTIFY_URL is not a valid URL' }; }
  if (!HTTP_SCHEMES.has(url.protocol)) {
    return { ...OFF, disabledReason: 'BELAY_NOTIFY_URL must be http(s)' };
  }

  const fmtRaw = (productEnv('NOTIFY_FORMAT', env) || 'ntfy').trim().toLowerCase();
  if (fmtRaw !== 'ntfy' && fmtRaw !== 'json') {
    return { ...OFF, disabledReason: `unknown BELAY_NOTIFY_FORMAT "${fmtRaw}" (use ntfy or json)` };
  }

  // Unknown event names are a config error, not something to guess around:
  // "approvals" quietly meaning "no notifications at all" would recreate the
  // silent-phone bug this module exists to fix.
  const evRaw = (productEnv('NOTIFY_EVENTS', env) || '').trim();
  const events = new Set<NotifyEventClass>();
  if (evRaw) {
    for (const part of evRaw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
      if (part !== 'approval' && part !== 'done' && part !== 'error') {
        return { ...OFF, disabledReason: `unknown event "${part}" in BELAY_NOTIFY_EVENTS (use approval, done, error)` };
      }
      events.add(part);
    }
  }
  if (events.size === 0) for (const e of DEFAULT_EVENTS) events.add(e);

  const detailRaw = (productEnv('NOTIFY_DETAIL', env) || '').trim().toLowerCase();
  return {
    enabled: true,
    url: url.toString(),
    format: fmtRaw,
    token: (productEnv('NOTIFY_TOKEN', env) || '').trim(),
    includeDetail: detailRaw === '1' || detailRaw === 'on' || detailRaw === 'true' || detailRaw === 'yes',
    events,
  };
}

/** Which config class a kind is gated by. */
export function eventClassOf(kind: NotifyKind): NotifyEventClass {
  return kind === 'expired' ? 'approval' : kind;
}

// ---- message construction --------------------------------------------------

/** "28 min", "3 h" — coarse on purpose; a lock screen is not a stopwatch. */
function minutesLeftText(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return 'It waits until you answer.';
  const min = Math.max(1, Math.round((expiresAt - now) / 60000));
  if (min >= 120) return `${Math.round(min / 60)} h to answer, then it is denied.`;
  return `${min} min to answer, then it is denied.`;
}

export interface NotifyMessage {
  readonly title: string;
  readonly body: string;
  /** ntfy priority word; "high" breaks through more delivery throttling. */
  readonly priority: 'high' | 'default';
  /** Deep link back into the app, straight to the session that asked. */
  readonly link: string;
}

/**
 * The human-readable notification, built once and shared by both formats so
 * the lock screen reads the same whether it arrived via ntfy or a custom
 * relay. Everything a decision needs — which computer, which session, what is
 * being asked, how long is left — and, only when opted in, what exactly.
 */
export function buildMessage(ev: NotifyEvent, includeDetail: boolean, now = Date.now()): NotifyMessage {
  const link = `belay://agent?host=${encodeURIComponent(ev.hostId)}&session=${encodeURIComponent(ev.session.id)}`;
  const who = `"${ev.session.title}"`;
  const detail = includeDetail && ev.detail
    ? ` — ${ev.detail.length > DETAIL_CAP ? ev.detail.slice(0, DETAIL_CAP) + '…' : ev.detail}`
    : '';

  switch (ev.kind) {
    case 'approval':
      return {
        title: `${ev.host}: Claude needs a decision`,
        body: `${who} wants to run ${ev.tool || 'a tool'}${detail}. ${minutesLeftText(ev.expiresAt, now)}`,
        priority: 'high', link,
      };
    case 'expired':
      return {
        title: `${ev.host}: approval expired`,
        body: `${who}: nobody answered — ${ev.tool || 'the tool'}${detail} was denied after ${ev.waitedMin ?? '?'} min. Send a prompt to resume.`,
        priority: 'high', link,
      };
    case 'done': {
      const secs = ev.durationMs !== undefined ? ` in ${Math.max(1, Math.round(ev.durationMs / 1000))}s` : '';
      const cost = ev.costUsd !== undefined ? ` ($${ev.costUsd.toFixed(2)})` : '';
      return ev.ok === false
        ? { title: `${ev.host}: turn failed`, body: `${who} finished with an error${secs}.`, priority: 'high', link }
        : { title: `${ev.host}: turn finished`, body: `${who} is done${secs}${cost}. Claude waits for your next prompt.`, priority: 'default', link };
    }
    case 'error':
      return {
        title: `${ev.host}: session stopped`,
        body: `${who}: ${ev.text || 'the Claude process exited'}. Send a prompt to resume.`,
        priority: 'high', link,
      };
  }
}

// ---- request construction --------------------------------------------------

// HTTP header values must be latin-1; a host label can be anything. The body
// stays UTF-8 (that is where the text actually shows), so headers only need
// to survive, not to be pretty.
function headerSafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x20-\x7e]/g, '?');
}

export interface NotifyRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The wire shape, as data. Returns null when the config or the event class
 * says not to send — callers need no second gate. Pure, so tests can assert
 * exactly what would transit the network without a network.
 */
export function buildRequest(cfg: NotifyConfig, ev: NotifyEvent, now = Date.now()): NotifyRequest | null {
  if (!cfg.enabled || !cfg.events.has(eventClassOf(ev.kind))) return null;
  const msg = buildMessage(ev, cfg.includeDetail, now);
  const auth: Record<string, string> = cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};

  if (cfg.format === 'ntfy') {
    return {
      url: cfg.url,
      headers: {
        ...auth,
        'Content-Type': 'text/plain; charset=utf-8',
        // ntfy reads these; anything else ignores unknown headers harmlessly.
        Title: headerSafe(msg.title),
        Priority: msg.priority,
        Tags: ev.kind === 'approval' ? 'bell' : ev.kind === 'done' ? 'white_check_mark' : 'warning',
        Click: msg.link,
      },
      body: msg.body,
    };
  }

  // Generic JSON. `text` and `content` duplicate title+body on purpose: a
  // Slack incoming webhook renders `text` and ignores the rest, a Discord
  // webhook renders `content` and ignores the rest — so the same payload
  // works unmodified on both, and everything else gets the structured fields.
  const line = `${msg.title} — ${msg.body}`;
  return {
    url: cfg.url,
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: ev.kind,
      host: ev.host,
      hostId: ev.hostId,
      session: { id: ev.session.id, title: ev.session.title },
      ...(ev.tool ? { tool: ev.tool } : {}),
      ...(cfg.includeDetail && ev.detail ? { detail: ev.detail } : {}),
      ...(ev.expiresAt !== undefined ? { expiresAt: ev.expiresAt } : {}),
      title: msg.title,
      message: msg.body,
      priority: msg.priority,
      link: msg.link,
      text: line,
      content: line,
    }),
  };
}

// ---- delivery ---------------------------------------------------------------

// Failure is logged on the ok→fail edge only: a webhook that is down while
// ten approvals fire should cost one log line, not ten — and a recovery is
// worth one line too, so "did my notifications come back?" has an answer in
// the same terminal. The URL is redacted to its origin: the path is the ntfy
// topic, which works like a capability, and the token never appears anywhere.
let webhookWasFailing = false;

function logFailure(url: string, reason: string): void {
  if (webhookWasFailing) return;
  webhookWasFailing = true;
  let origin = 'the webhook';
  try { origin = new URL(url).origin; } catch { /* unparseable stays generic */ }
  console.error(`[notify] webhook POST to ${origin} failed (${reason}) — notifications are best-effort; the approval still waits on the phone as usual`);
}

function logRecovery(): void {
  if (!webhookWasFailing) return;
  webhookWasFailing = false;
  console.log('[notify] webhook reachable again');
}

/** Test hook: reset the once-only failure latch between cases. */
export function resetNotifyLogState(): void {
  webhookWasFailing = false;
}

/**
 * POST one notification. Resolves true/false, never rejects, never throws —
 * this promise is deliberately not awaited by any session code path, so even
 * "resolves eventually" is more than the approval flow depends on.
 */
export async function deliver(req: NotifyRequest, timeoutMs = NOTIFY_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logFailure(req.url, `HTTP ${res.status}`);
      return false;
    }
    logRecovery();
    return true;
  } catch (e: unknown) {
    const reason = e instanceof Error && e.name === 'TimeoutError'
      ? `no response in ${timeoutMs}ms`
      : e instanceof Error ? e.message : String(e);
    logFailure(req.url, reason);
    return false;
  }
}

// Resolved once and cached: the config is boot-time (env vars), and re-parsing
// it per notification buys nothing but per-call failure modes.
let cached: NotifyConfig | undefined;

export function notifyConfig(): NotifyConfig {
  if (cached === undefined) cached = loadNotifyConfig();
  return cached;
}

/**
 * Fire-and-forget entry point for agent.ts. Synchronous, void, and wrapped so
 * that no conceivable failure — bad config, a throwing URL parse, fetch
 * itself missing — can travel back into the approval path that called it.
 */
export function notify(ev: NotifyEvent, cfg: NotifyConfig = notifyConfig()): void {
  try {
    const req = buildRequest(cfg, ev);
    if (req) void deliver(req);
  } catch { /* a notification must never hurt a session */ }
}

// ---- boot banner ------------------------------------------------------------

/** Credentials-free description of where notifications go, for the banner. */
function printableUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Basic-auth in the URL is a credential; the banner shows where, not how.
    return `${u.origin}${u.pathname}`;
  } catch { return 'the configured webhook'; }
}

/** One status line for the boot banner, following the `Agent :` pattern. */
export function notifyBannerLine(cfg: NotifyConfig = notifyConfig()): string {
  if (!cfg.enabled) {
    return cfg.disabledReason
      ? `OFF — ${cfg.disabledReason}`
      : 'off — set BELAY_NOTIFY_URL to get pinged when Claude needs you (docs/AGENT.md)';
  }
  const events = [...cfg.events].join('+');
  const detail = cfg.includeDetail ? 'with command detail' : 'metadata only';
  return `${printableUrl(cfg.url)} (${cfg.format}, ${events}, ${detail})`;
}
