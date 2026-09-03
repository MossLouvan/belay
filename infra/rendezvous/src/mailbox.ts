// Session brokering: one mailbox per rendezvous identity, two sides, signaling
// relayed opaquely between them.
//
// This is server/src/webrtc/bridge.ts's job lifted off the LAN: the host and
// client are NOT on the same network and share no socket, so each attaches to
// the rendezvous independently and the mailbox is the meeting point. Semantics
// deliberately mirror SignalingBridge — validate every frame, bind the first
// session id, reject stale ids, `bye` is terminal — with one addition the WAN
// forces: an ATTACH ORDER RACE. The client's offer and trickled ICE may arrive
// before the host has attached (or re-attached after a blip), so frames for an
// absent peer are buffered, bounded, and flushed in order on attach.
//
// What the mailbox never does: verify the end-to-end seal (it does not hold
// the key), parse SDP, or mint access. A mailbox connects whoever presents the
// same mailboxId; the sealed signaling is what makes a forged or misrouted
// introduction useless (see server/src/webrtc/envelope.ts).

import { validateSignal, type ValidSignal, type ValidationResult } from './signal.js';

export type MailboxSide = 'host' | 'client';

export interface SignalSink {
  deliver(message: ValidSignal): void;
}

export const MAILBOX_LIMITS = Object.freeze({
  /** Frames buffered for an absent peer. An offer + a generous trickle of ICE
   *  fits well inside this; a flood does not. */
  maxBufferedFrames: 32,
  maxBufferedBytes: 96 * 1024,
  /** Mailboxes a single registry instance will hold. */
  maxMailboxes: 100_000,
  /** An idle, half-attached mailbox is reaped after this long. */
  idleTtlMs: 120_000,
  idPattern: /^[A-Za-z0-9._-]{8,128}$/,
});

export type AttachResult =
  | { readonly ok: true; readonly mailbox: Mailbox }
  | { readonly ok: false; readonly error: string };

interface Buffered {
  readonly message: ValidSignal;
  readonly bytes: number;
}

/** One brokered session: at most one host side and one client side. */
export class Mailbox {
  private readonly sinks: { host: SignalSink | null; client: SignalSink | null } = { host: null, client: null };
  private readonly buffers: { host: Buffered[]; client: Buffered[] } = { host: [], client: [] };
  private readonly bufferedBytes: { host: number; client: number } = { host: 0, client: 0 };
  private boundSessionId: string | null = null;
  private closed = false;
  // A terminal `bye` was buffered for an absent peer: the session is over for
  // the sender, but teardown is deferred until this side attaches and drains
  // the bye (or the idle reaper collects an abandoned mailbox). Retention is
  // therefore bounded by MAILBOX_LIMITS.idleTtlMs — never unbounded.
  private pendingByeFor: MailboxSide | null = null;
  private lastActivityMs: number;

  constructor(
    readonly mailboxId: string,
    private readonly now: () => number,
    private readonly onClose: () => void,
  ) {
    this.lastActivityMs = now();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get sessionId(): string | null {
    return this.boundSessionId;
  }

  /** True when this mailbox has been idle past the reap TTL. */
  isExpired(nowMs: number): boolean {
    return nowMs - this.lastActivityMs > MAILBOX_LIMITS.idleTtlMs;
  }

  /** Attach one side. Exactly one host and one client per mailbox: a second
   *  attach on an occupied side is refused, never a silent takeover — a live
   *  session cannot be hijacked out from under a peer by re-attaching. */
  attach(side: MailboxSide, sink: SignalSink): { readonly ok: boolean; readonly error?: string } {
    if (this.closed) return { ok: false, error: 'mailbox closed' };
    if (this.sinks[side] !== null) return { ok: false, error: `${side} side already attached` };
    this.sinks[side] = sink;
    this.lastActivityMs = this.now();

    const pending = this.buffers[side];
    this.buffers[side] = [];
    this.bufferedBytes[side] = 0;
    for (const item of pending) sink.deliver(item.message);

    // If this side was holding a deferred terminal `bye`, it has now been
    // drained to the peer — complete the teardown that was postponed so the
    // absent peer could learn the session ended.
    if (this.pendingByeFor === side) this.close();
    return { ok: true };
  }

  /** Detach one side (socket closed). The mailbox survives so the peer can
   *  re-attach after a network blip; the reaper collects true abandonments. */
  detach(side: MailboxSide): void {
    this.sinks[side] = null;
    this.lastActivityMs = this.now();
  }

  /**
   * Ingest one raw frame from `from`, validate, and relay toward the opposite
   * side — delivering live when attached, buffering (bounded) when not.
   * Never throws; a malformed or stale frame is a clean rejection.
   */
  ingest(from: MailboxSide, raw: unknown): ValidationResult {
    if (this.closed) return { ok: false, error: 'mailbox closed' };
    // A terminal bye is committed but not yet drained: the session is over, so
    // the sender cannot push further frames through it.
    if (this.pendingByeFor !== null) return { ok: false, error: 'mailbox closed' };

    const result = validateSignal(raw);
    if (!result.ok) return result;

    const { sessionId } = result.message;
    if (this.boundSessionId === null) {
      this.boundSessionId = sessionId;
    } else if (sessionId !== this.boundSessionId) {
      return { ok: false, error: `stale session '${sessionId}' (mailbox bound to '${this.boundSessionId}')` };
    }

    this.lastActivityMs = this.now();
    const to: MailboxSide = from === 'client' ? 'host' : 'client';
    const sink = this.sinks[to];
    if (sink) {
      sink.deliver(result.message);
    } else {
      const bytes = frameBytes(result.message);
      if (
        this.buffers[to].length >= MAILBOX_LIMITS.maxBufferedFrames ||
        this.bufferedBytes[to] + bytes > MAILBOX_LIMITS.maxBufferedBytes
      ) {
        return { ok: false, error: 'peer absent and buffer full' };
      }
      this.buffers[to].push({ message: result.message, bytes });
      this.bufferedBytes[to] += bytes;
    }

    if (result.message.kind === 'bye') {
      if (sink) {
        // Peer is present and already received the bye live — tear down now.
        this.close();
      } else {
        // Peer is absent: the bye is buffered. Defer teardown so a peer that
        // (re)attaches shortly still drains the terminal frame instead of
        // opening a fresh mailbox that silently lost it. Bounded by the reaper.
        this.pendingByeFor = to;
      }
    }
    return result;
  }

  /** Terminal. Buffers are dropped; further attach/ingest is refused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingByeFor = null;
    this.sinks.host = null;
    this.sinks.client = null;
    this.buffers.host = [];
    this.buffers.client = [];
    this.onClose();
  }
}

function frameBytes(message: ValidSignal): number {
  return (
    Buffer.byteLength(message.sdp ?? '', 'utf8') +
    Buffer.byteLength(message.candidate ?? '', 'utf8') +
    Buffer.byteLength(message.reason ?? '', 'utf8') +
    Buffer.byteLength(message.seal ?? '', 'utf8') +
    Buffer.byteLength(message.sessionId, 'utf8') +
    16
  );
}

export interface MailboxRegistry {
  /** Get-or-create the mailbox for an id. Refuses invalid ids and a full table. */
  open(mailboxId: string): AttachResult;
  /** Live mailbox count (after reaping). */
  size(): number;
  /** Reap idle mailboxes. Exposed for tests and a periodic sweep. */
  reap(): void;
}

export function createMailboxRegistry(
  now: () => number = Date.now,
  maxMailboxes: number = MAILBOX_LIMITS.maxMailboxes,
): MailboxRegistry {
  const mailboxes = new Map<string, Mailbox>();

  const reap = (): void => {
    const at = now();
    for (const [id, box] of mailboxes) {
      if (box.isClosed || box.isExpired(at)) {
        box.close();
        mailboxes.delete(id);
      }
    }
  };

  return {
    open(mailboxId: string): AttachResult {
      if (typeof mailboxId !== 'string' || !MAILBOX_LIMITS.idPattern.test(mailboxId)) {
        return { ok: false, error: 'invalid mailboxId' };
      }
      const existing = mailboxes.get(mailboxId);
      if (existing && !existing.isClosed) return { ok: true, mailbox: existing };
      if (existing) mailboxes.delete(mailboxId);

      if (mailboxes.size >= maxMailboxes) {
        reap();
        if (mailboxes.size >= maxMailboxes) return { ok: false, error: 'registry full' };
      }
      const box: Mailbox = new Mailbox(mailboxId, now, () => {
        // Closed mailboxes are removed lazily by open()/reap(); removing here
        // eagerly keeps size() honest without a sweep.
        mailboxes.delete(mailboxId);
      });
      mailboxes.set(mailboxId, box);
      return { ok: true, mailbox: box };
    },

    size(): number {
      reap();
      return mailboxes.size;
    },

    reap,
  };
}
