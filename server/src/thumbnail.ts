// One still picture of this computer's desktop, on demand.
//
// Why this exists. Until now a frame of the host's screen only ever existed
// *inside* an open /ws/screen session, which made the one screen that most
// wants a picture — the phone's list of computers — the one screen that could
// never have one. The list is where no stream is open by definition. So the
// device cards drew an empty glyph tile and the mockups' "live desktop
// thumbnail" stayed undrawable.
//
// What this is NOT. Not a second stream, and not something a client may poll
// at a frame rate. Three rules keep it that way, and every one of them is a
// hard cap rather than a convention:
//
//   1. Machine-wide coalescing. At most ONE capture per FRESH_MS across all
//      callers; anything inside that window is answered from the last picture
//      taken. Two phones asking at once cost one capture, and a caller that
//      asks ten times a second costs nothing extra. This is what keeps the
//      route from competing with a live stream for the same GPU — the JPEG
//      loop in index.ts already runs a capture almost continuously, and a
//      second uncoordinated capture loop halves the frame rate of the one the
//      user is actually looking at.
//   2. A per-device request budget. Coalescing bounds the host's work; this
//      bounds the request flood itself, so a broken client gets a 429 with a
//      Retry-After instead of a free unbounded loop through express.
//   3. A byte ceiling. The picture is captured small to begin with (a card
//      thumbnail is ~112pt wide), and a frame that still comes back over the
//      cap is retried once smaller and then refused. A "thumbnail" is never
//      allowed to become a megabyte of someone's desktop crossing a cellular
//      link.
//
// Privacy. This is a photograph of the owner's desktop. It is held in memory
// for a few seconds and nowhere else — never written to disk, never logged,
// never included in an error message. It requires the same bearer token as
// capture and input, because it IS capture: seeing the screen once is not a
// lesser privilege than seeing it sixty times a second.

import type { Express, Request, RequestHandler, Response } from 'express';

import { messageOf } from './errors.js';

/** Every bound this route lives inside. All hard caps, none negotiable by a client. */
export const THUMB = Object.freeze({
  /** Capture width in px. A device card draws ~112pt; 320 survives a 3x screen. */
  width: 320,
  /** JPEG quality. Low on purpose: this is a recognisable glance, not a document. */
  quality: 40,
  /** How long one captured picture is reused for every caller, machine-wide. */
  freshMs: 5_000,
  /** Requests one paired device may make per window before it is refused. */
  burst: 10,
  /** The window that budget refills over. */
  windowMs: 10_000,
  /** Hard ceiling on the JPEG returned. 320px of desktop is ~20-40 KB. */
  maxBytes: 256 * 1024,
  /** Second, smaller attempt when a capture somehow lands over the ceiling. */
  retryWidth: 192,
  retryQuality: 25,
} as const);

/** The shape `native.capture` already returns; re-declared so tests need no helper. */
export interface ThumbFrame {
  readonly data: string;
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
  readonly bytes: number;
}

/** What the phone receives. `capturedAt` lets it age the picture itself. */
export interface ThumbReply extends ThumbFrame {
  readonly capturedAt: number;
  /** True when this picture was taken for an earlier caller inside `freshMs`. */
  readonly cached: boolean;
}

export interface ThumbnailDeps {
  /** Take one downscaled JPEG. Normally `native.capture(w, q, false)`. */
  readonly capture: (width: number, quality: number) => Promise<ThumbFrame>;
  /** Whether capture could work at all right now (helper built AND alive). */
  readonly ready: () => boolean;
  readonly now?: () => number;
  readonly freshMs?: number;
  readonly burst?: number;
  readonly windowMs?: number;
  readonly maxBytes?: number;
}

/** Only the field this module reads off an authenticated request. */
interface MaybeAuthed extends Request {
  device?: { token?: string };
}

export type BudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSec: number };

/**
 * A fixed-window request budget, per key.
 *
 * Fixed window rather than a token bucket because the failure it guards is a
 * runaway client, not a careful attacker pacing himself at the boundary: the
 * worst a window edge allows is two bursts back to back, which is still two
 * coalesced captures. Keys are dropped as soon as their window lapses, so a
 * long-lived host does not accumulate one entry per token that ever asked.
 */
export class RequestBudget {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** key → [window start, count in that window]. */
  private windows = new Map<string, readonly [number, number]>();

  constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? THUMB.burst;
    this.windowMs = options.windowMs ?? THUMB.windowMs;
    this.now = options.now ?? Date.now;
  }

  check(key: string): BudgetDecision {
    const at = this.now();
    this.sweep(at);
    const current = this.windows.get(key);
    if (!current || at - current[0] >= this.windowMs) {
      this.windows = new Map(this.windows).set(key, [at, 1]);
      return { allowed: true };
    }
    const [startedAt, used] = current;
    if (used >= this.limit) {
      const waitMs = this.windowMs - (at - startedAt);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    this.windows = new Map(this.windows).set(key, [startedAt, used + 1]);
    return { allowed: true };
  }

  /** Entries whose window has lapsed carry no information; drop them. */
  private sweep(at: number): void {
    if (this.windows.size === 0) return;
    const live = [...this.windows].filter(([, [startedAt]]) => at - startedAt < this.windowMs);
    if (live.length !== this.windows.size) this.windows = new Map(live);
  }
}

/** Raised when a capture comes back over the byte ceiling even after the retry. */
export class ThumbnailTooLargeError extends Error {
  constructor() { super('the thumbnail came back larger than this route allows'); }
}

/**
 * One picture of the desktop, shared by everyone who asks inside `freshMs`.
 *
 * Two separate jobs, both about not capturing twice:
 *   - `inFlight` coalesces *concurrent* askers onto one capture. Without it,
 *     two phones opening the list at the same moment fire two captures.
 *   - `last` coalesces *sequential* askers. Without it, a client that
 *     re-renders answers every request with a fresh capture.
 */
export class ThumbnailSource {
  private readonly deps: Required<Pick<ThumbnailDeps, 'capture' | 'ready'>>;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly maxBytes: number;
  private last: ThumbReply | null = null;
  private inFlight: Promise<ThumbReply> | null = null;

  constructor(deps: ThumbnailDeps) {
    this.deps = { capture: deps.capture, ready: deps.ready };
    this.now = deps.now ?? Date.now;
    this.freshMs = deps.freshMs ?? THUMB.freshMs;
    this.maxBytes = deps.maxBytes ?? THUMB.maxBytes;
  }

  /** Whether a picture could be produced at all. False means 503, not 500. */
  ready(): boolean {
    return this.deps.ready();
  }

  /** Forget the held picture. Called when the last paired device is revoked. */
  forget(): void {
    this.last = null;
  }

  async get(): Promise<ThumbReply> {
    const fresh = this.last;
    if (fresh && this.now() - fresh.capturedAt < this.freshMs) {
      return { ...fresh, cached: true };
    }
    if (this.inFlight) return this.inFlight;
    const run = this.take()
      .then((reply) => { this.last = reply; return reply; })
      .finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  /**
   * The capture itself, plus the size bound.
   *
   * A frame over the ceiling is retried once at a smaller size rather than
   * refused outright: the overwhelming cause is a busy, high-entropy desktop
   * at a high DPI, and shrinking it is exactly the right answer. A second
   * failure is refused, because at that point something is wrong with the
   * helper and guessing again would just burn more captures.
   */
  private async take(): Promise<ThumbReply> {
    if (!this.deps.ready()) {
      throw new Error('screen capture is not available on this computer right now');
    }
    const first = await this.deps.capture(THUMB.width, THUMB.quality);
    if (jpegBytes(first) <= this.maxBytes) return this.reply(first);
    const smaller = await this.deps.capture(THUMB.retryWidth, THUMB.retryQuality);
    if (jpegBytes(smaller) <= this.maxBytes) return this.reply(smaller);
    throw new ThumbnailTooLargeError();
  }

  /**
   * Exactly the declared fields, never a spread of the helper's whole answer.
   *
   * The native helper replies with its own protocol noise alongside the frame
   * (a request id, an `ok` flag, an age counter). Spreading it would put that
   * on the wire as part of a documented route's shape, where it would quietly
   * become something a client could come to depend on.
   */
  private reply(frame: ThumbFrame): ThumbReply {
    return {
      data: frame.data,
      w: frame.w,
      h: frame.h,
      sw: frame.sw,
      sh: frame.sh,
      bytes: jpegBytes(frame),
      capturedAt: this.now(),
      cached: false,
    };
  }
}

/**
 * The true size of the JPEG, measured rather than trusted.
 *
 * `bytes` is the helper's own count and is what every other frame consumer
 * uses, but the ceiling here is a safety bound: measuring the base64 payload
 * means a helper that under-reports cannot talk its way past it.
 */
export function jpegBytes(frame: Pick<ThumbFrame, 'data' | 'bytes'>): number {
  const encoded = frame.data?.length ?? 0;
  if (encoded === 0) return Math.max(0, frame.bytes ?? 0);
  const padding = frame.data.endsWith('==') ? 2 : frame.data.endsWith('=') ? 1 : 0;
  return Math.floor((encoded * 3) / 4) - padding;
}

/**
 * Register `GET /screen/thumbnail`.
 *
 * Same `auth` handler as every other privileged route, so a revoked device
 * loses the picture at the same instant it loses the stream. The budget is
 * keyed on the device's own token — the identity auth already established —
 * falling back to the peer address only for the impossible case of an auth
 * handler that admits a request without attaching a device.
 */
export function registerThumbnailRoutes(app: Express, auth: RequestHandler, deps: ThumbnailDeps): ThumbnailSource {
  const source = new ThumbnailSource(deps);
  const budget = new RequestBudget({ limit: deps.burst, windowMs: deps.windowMs, now: deps.now });

  app.get('/screen/thumbnail', auth, async (req: MaybeAuthed, res: Response) => {
    const key = req.device?.token || req.ip || 'unknown';
    const decision = budget.check(key);
    if (!decision.allowed) {
      res.set('Retry-After', String(decision.retryAfterSec));
      res.status(429).json({
        error: 'too many thumbnail requests; slow down',
        retryAfterSec: decision.retryAfterSec,
      });
      return;
    }
    if (!source.ready()) {
      res.status(503).json({ error: 'screen capture is not available on this computer right now' });
      return;
    }
    try {
      const reply = await source.get();
      // No caching by anything in between: this is a picture of a desktop, and
      // the freshness policy lives in this process, not in a proxy.
      res.set('Cache-Control', 'no-store');
      res.json(reply);
    } catch (e: unknown) {
      // Everything that can go wrong here is "the host cannot show you its
      // screen right now" — no permission, helper down, desktop locked — and
      // 503 is the honest answer for all of them. The phone shows its empty
      // tile rather than an error the user cannot act on.
      res.status(503).json({ error: messageOf(e) });
    }
  });

  return source;
}
