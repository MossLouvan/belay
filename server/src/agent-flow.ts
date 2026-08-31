// The session's conversational state machine — prompts, the one-slot queue,
// interrupts, and the approval lifecycle — pulled out of agent.ts so it can
// be driven in tests without spawning a claude process. agent.ts owns
// processes, persistence and subscribers; this file owns *decisions*, and
// talks back through the narrow FlowIO seam. Every side effect a decision
// needs (a feed line, a broadcast, a webhook ping, bytes to stdin) goes
// through that seam, which is also what keeps the notification promise easy
// to audit: an ask is always fully raised and waiting before ping is called,
// and an ask a grant swallows still leaves a visible feed line behind.

import { randomBytes } from 'node:crypto';
import { toolDetail } from './agent-events.js';
import type { AgentEvent } from './agent-events.js';
import { grantForChoice, grantMatches, riskTier, scopeChoicesFor } from './approval-scopes.js';
import type { ApprovalGrant, RiskTier, ScopeChoice } from './approval-scopes.js';
import { buildPreview } from './approval-preview.js';
import type { ApprovalPreview } from './approval-preview.js';

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
}

export interface PendingState {
  id: string;
  tool: string;
  detail: string;
  /** Pretty JSON of the input, trimmed — the card's "show full input" fallback. */
  input: string;
  /** The input as claude sent it, kept so a grant is minted from what was shown. */
  rawInput: unknown;
  risk: RiskTier;
  choices: ScopeChoice[];
  preview?: ApprovalPreview;
  expiresAt?: number;
  resolve: (allow: boolean, message?: string) => void;
  timer?: NodeJS.Timeout;
}

/** The slice of a session this machine reads and writes. */
export interface FlowSession {
  readonly id: string;
  readonly cwd: string;
  status: AgentStatus;
  pending?: PendingState;
  queued?: QueuedPrompt;
  grants: readonly ApprovalGrant[];
}

/** Everything a decision may do to the world. agent.ts binds the real ones. */
export interface FlowIO {
  /** Feed + transcript + broadcast, i.e. agent.ts's pushEvent. */
  push(ev: AgentEvent): void;
  /** Raw websocket broadcast to this session's subscribers. */
  send(msg: object): void;
  setStatus(status: AgentStatus): void;
  /** Hand a user message to the claude process (spawning it if needed). */
  deliver(text: string): void;
  /** Ask the running turn to halt (stream-json control request). Best effort. */
  interruptTurn(): void;
  /** The notification webhook — see agent.ts's ping. */
  ping(ev: { kind: 'approval' | 'expired'; tool?: string; detail?: string; expiresAt?: number; waitedMin?: number }): void;
}

const newId = (): string => randomBytes(6).toString('hex');

const isBusy = (s: FlowSession): boolean => s.status === 'running' || s.status === 'waiting';

/** The wire shape of a grant: everything but the resolver-only value field. */
export const grantSummary = (g: ApprovalGrant) =>
  ({ id: g.id, tool: g.tool, label: g.label, createdAt: g.createdAt });

const sendGrants = (s: FlowSession, io: FlowIO): void =>
  io.send({ type: 'grants', grants: s.grants.map(grantSummary) });

const sendQueued = (s: FlowSession, io: FlowIO): void =>
  io.send({ type: 'queued', queued: s.queued ?? null });

// ---- prompts and the queue --------------------------------------------------

/**
 * A prompt from the phone. Idle sessions get it immediately; a busy session
 * queues it for the moment the turn ends — one slot, latest intent wins, and
 * the replace is visible because the queued broadcast always carries the
 * current text. Refusing (the old behaviour) taught people the Stop button;
 * queueing is what a phone-shaped fire-and-forget actually needs.
 */
export function flowPrompt(s: FlowSession, io: FlowIO, text: string): 'sent' | 'queued' {
  if (isBusy(s)) {
    s.queued = { id: newId(), text };
    sendQueued(s, io);
    return 'queued';
  }
  io.push({ t: Date.now(), kind: 'user', text });
  io.setStatus('running');
  io.deliver(text);
  return 'sent';
}

export function flowCancelQueued(s: FlowSession, io: FlowIO): boolean {
  if (!s.queued) return false;
  s.queued = undefined;
  sendQueued(s, io);
  io.push({ t: Date.now(), kind: 'info', text: 'queued prompt cancelled' });
  return true;
}

/** Drop the queue without firing it — for stop and for a dead process. */
export function flowDropQueued(s: FlowSession, io: FlowIO, why: string): void {
  if (!s.queued) return;
  s.queued = undefined;
  sendQueued(s, io);
  io.push({ t: Date.now(), kind: 'info', text: `queued prompt dropped — ${why}` });
}

/**
 * The turn ended. Fires the queued prompt if one is waiting; returns whether
 * it did, so agent.ts knows whether the session is actually idle (idle-kill
 * timers and the like stay its business).
 */
export function flowTurnDone(s: FlowSession, io: FlowIO): boolean {
  const queued = s.queued;
  if (!queued) {
    io.setStatus('idle');
    return false;
  }
  s.queued = undefined;
  sendQueued(s, io);
  io.push({ t: Date.now(), kind: 'user', text: queued.text });
  io.setStatus('running');
  io.deliver(queued.text);
  return true;
}

/**
 * Interrupt-with-message: the deliberate sibling of the queue. Where a
 * queued prompt waits its turn, this one halts the turn to be heard.
 *
 * Blocked on an approval, the interrupt IS the denial: the deny message is
 * the one channel that reaches claude mid-turn, so the user's words ride it
 * and steer the same turn. Mid-execution, the turn is asked to halt and the
 * message takes the queue slot — halting is best-effort (older CLIs may
 * ignore the control request), and the queue is what guarantees the message
 * lands either way, at worst when the turn ends naturally.
 */
export function flowInterrupt(s: FlowSession, io: FlowIO, text: string): 'sent' | 'steered' | 'interrupted' {
  const pending = s.pending;
  if (s.status === 'waiting' && pending) {
    clearTimeout(pending.timer);
    s.pending = undefined;
    io.push({ t: Date.now(), kind: 'user', text });
    io.push({
      t: Date.now(), kind: 'info',
      text: `interrupted — denied ${pending.tool} so Claude reads the new instruction now`,
    });
    io.send({ type: 'permission-clear' });
    io.setStatus('running');
    pending.resolve(false, `The user interrupted with new instructions: ${text}\nStop the current approach and follow these instead.`);
    return 'steered';
  }
  if (s.status === 'running') {
    s.queued = { id: newId(), text };
    sendQueued(s, io);
    io.push({ t: Date.now(), kind: 'info', text: 'interrupting — Claude is being asked to stop this turn; the message sends the moment it does' });
    io.interruptTurn();
    return 'interrupted';
  }
  flowPrompt(s, io, text);
  return 'sent';
}

// ---- approvals --------------------------------------------------------------

const INPUT_PRETTY_CAP = 2000;

/**
 * A permission ask from the sidecar. Resolves when a standing grant covers
 * it, when the phone answers, or when the clock runs out (fail closed).
 * A grant that swallows the ask still leaves a feed line — a permission the
 * user cannot see firing is a trapdoor, and the feed is where it stays
 * visible — and the webhook ping only ever happens *after* the ask is fully
 * raised, so no notification path can stand between claude and an answer.
 */
export function flowRequestApproval(
  s: FlowSession, io: FlowIO, toolName: string, input: unknown, timeoutMs: number,
  onExpire: (approvalId: string) => void,
): Promise<{ allow: boolean; message?: string }> {
  const covered = s.grants.find((g) => grantMatches(g, toolName, input, s.cwd));
  if (covered) {
    io.push({
      t: Date.now(), kind: 'info',
      text: `allowed without asking — ${covered.label}`,
      tool: toolName, detail: toolDetail(toolName, input),
    });
    return Promise.resolve({ allow: true });
  }
  if (s.pending) {
    // claude asks one at a time; a second concurrent ask means something is
    // off — fail closed rather than queue.
    return Promise.resolve({ allow: false, message: 'another approval is already pending' });
  }
  return new Promise((resolve) => {
    const id = newId();
    const pretty = JSON.stringify(input ?? {}, null, 2);
    const pending: PendingState = {
      id,
      tool: toolName,
      detail: toolDetail(toolName, input),
      input: pretty.length > INPUT_PRETTY_CAP ? pretty.slice(0, INPUT_PRETTY_CAP) + '…' : pretty,
      rawInput: input,
      risk: riskTier(toolName, input, s.cwd),
      choices: scopeChoicesFor(toolName, input, s.cwd),
      preview: buildPreview(toolName, input, s.cwd),
      expiresAt: timeoutMs ? Date.now() + timeoutMs : undefined,
      resolve: (allow: boolean, message?: string) => resolve({ allow, message }),
      timer: timeoutMs ? setTimeout(() => onExpire(id), timeoutMs) : undefined,
    };
    s.pending = pending;
    io.setStatus('waiting');
    io.send({ type: 'permission', request: pendingWire(pending) });
    // After the ask is fully raised and waiting, so a webhook — however
    // broken — can only ever be in addition to the approval, never in its way.
    io.ping({ kind: 'approval', tool: pending.tool, detail: pending.detail, expiresAt: pending.expiresAt });
  });
}

/** The pending ask as the phone sees it, on both the broadcast and the snapshot. */
export function pendingWire(p: PendingState) {
  return {
    id: p.id, tool: p.tool, detail: p.detail, input: p.input,
    expiresAt: p.expiresAt, risk: p.risk, choices: p.choices, preview: p.preview,
  };
}

/**
 * The ask ran out of clock with nobody there. Distinct from flowAnswer on
 * purpose: a deny the user tapped and a deny nobody chose must not read the
 * same afterwards. The feed gets a loud `error` line that survives in the
 * transcript, and claude is told the silence was absence, not refusal.
 */
export function flowExpire(s: FlowSession, io: FlowIO, approvalId: string, timeoutMs: number): void {
  if (!s.pending || s.pending.id !== approvalId) return;
  const pending = s.pending;
  s.pending = undefined;
  const mins = Math.max(1, Math.round(timeoutMs / 60000));
  io.push({
    t: Date.now(), kind: 'error',
    text: `nobody answered — ${pending.tool}${pending.detail ? ' (' + pending.detail.slice(0, 80) + ')' : ''} was denied after ${mins} min with no one there. Send a prompt to have Claude pick the work back up.`,
  });
  io.send({ type: 'permission-clear' });
  io.setStatus('running');
  io.ping({ kind: 'expired', tool: pending.tool, detail: pending.detail, waitedMin: mins });
  pending.resolve(false, `No one answered the approval on the phone within ${mins} minutes. This is absence, not refusal — stop what you are doing cleanly and summarise what remains, so the user can resume and ask you to retry.`);
}

/**
 * The user answered. `choiceId` is the scoped path (mint exactly the grant
 * whose label was tapped); `legacyAlways` is the old bare boolean, which now
 * narrows to the first — narrowest — offered choice instead of the whole
 * tool. Danger-tier asks offer no choices, so on those both spellings decay
 * to allow-once: the barn door does not survive being asked politely.
 */
export function flowAnswer(
  s: FlowSession, io: FlowIO, approvalId: string, allow: boolean,
  opts: { message?: string; legacyAlways?: boolean; choiceId?: string } = {},
): boolean {
  if (!s.pending || s.pending.id !== approvalId) return false;
  const pending = s.pending;
  clearTimeout(pending.timer);
  s.pending = undefined;
  if (allow) {
    const wanted = opts.choiceId ?? (opts.legacyAlways ? pending.choices[0]?.id : undefined);
    const grant = wanted
      ? grantForChoice(pending.tool, pending.rawInput, wanted, s.cwd, newId)
      : null;
    if (grant) {
      s.grants = [...s.grants, grant];
      io.push({ t: Date.now(), kind: 'info', text: `granted — ${grant.label}` });
      sendGrants(s, io);
    }
  }
  io.push({
    t: Date.now(), kind: 'info',
    text: `${allow ? 'allowed' : 'denied'} ${pending.tool}${pending.detail ? ': ' + pending.detail.slice(0, 80) : ''}`,
  });
  io.send({ type: 'permission-clear' });
  io.setStatus('running');
  pending.resolve(allow, opts.message || (allow ? undefined : 'The user denied this action from their phone.'));
  return true;
}

/** Withdraw one grant. Trust granted must be trust revocable — and visibly so. */
export function flowRevokeGrant(s: FlowSession, io: FlowIO, grantId: string): boolean {
  const grant = s.grants.find((g) => g.id === grantId);
  if (!grant) return false;
  s.grants = s.grants.filter((g) => g.id !== grantId);
  io.push({ t: Date.now(), kind: 'info', text: `revoked — ${grant.label}` });
  sendGrants(s, io);
  return true;
}
