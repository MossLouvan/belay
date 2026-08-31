// Pure state for the Agent tab: the `/ws/agent` wire protocol, the reducer
// that folds it into a session view, and the small formatting helpers the
// screens share. No React and no JSX, so `agent.test.mjs` can import it
// straight into Node.

import type {
  AgentEvent, AgentSnapshot, AgentStatus, ApprovalGrant, ApprovalPreview, ApprovalRisk,
  ApprovalScopeChoice, DiscoveredSession, PendingApproval, QueuedPrompt,
} from '../api';

/** Feed lines kept on the phone. The host caps its own transcript at 400 too. */
export const EVENT_CAP = 400;

/** A hold shorter than this is a mis-tap, not a prompt. */
export const MIN_HOLD_MS = 400;

// --- wire protocol -----------------------------------------------------------

export type AgentMessage =
  | { readonly type: 'hello'; readonly session: AgentSnapshot }
  | { readonly type: 'event'; readonly event: AgentEvent }
  | { readonly type: 'status'; readonly status: AgentStatus }
  | { readonly type: 'permission'; readonly request: PendingApproval }
  | { readonly type: 'permission-clear' }
  | { readonly type: 'queued'; readonly queued: QueuedPrompt | null }
  | { readonly type: 'grants'; readonly grants: readonly ApprovalGrant[] }
  | { readonly type: 'error'; readonly error: string };

const STATUSES: readonly AgentStatus[] = ['idle', 'running', 'waiting', 'error'];
const KINDS: readonly AgentEvent['kind'][] = ['user', 'text', 'tool', 'tool-result', 'result', 'info', 'error'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseStatus(v: unknown): AgentStatus | null {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v) ? (v as AgentStatus) : null;
}

/** An event from the host. Unknown kinds are dropped rather than rendered as garbage. */
export function parseEvent(v: unknown): AgentEvent | null {
  if (!isRecord(v)) return null;
  const kind = str(v.kind);
  if (!kind || !(KINDS as readonly string[]).includes(kind)) return null;
  return {
    t: num(v.t) ?? Date.now(),
    kind: kind as AgentEvent['kind'],
    text: str(v.text),
    tool: str(v.tool),
    detail: str(v.detail),
    ok: typeof v.ok === 'boolean' ? v.ok : undefined,
    costUsd: num(v.costUsd),
    durationMs: num(v.durationMs),
    callId: str(v.callId),
    chars: num(v.chars),
  };
}

const RISKS: readonly ApprovalRisk[] = ['read', 'edit', 'run', 'danger'];

function parseRisk(v: unknown): ApprovalRisk | undefined {
  return typeof v === 'string' && (RISKS as readonly string[]).includes(v) ? (v as ApprovalRisk) : undefined;
}

function parseChoices(v: unknown): ApprovalScopeChoice[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ApprovalScopeChoice[] = [];
  for (const c of v) {
    if (!isRecord(c)) continue;
    const id = str(c.id);
    const label = str(c.label);
    if (id && label) out.push({ id, label });
  }
  return out;
}

/**
 * A malformed preview degrades to no preview (the card falls back to the
 * detail line and raw input) rather than to a half-rendered diff — a diff
 * with a missing side would show a smaller change than the one being
 * approved, which is worse than showing none.
 */
function parsePreview(v: unknown): ApprovalPreview | undefined {
  if (!isRecord(v)) return undefined;
  if (v.kind === 'command') {
    const command = str(v.command);
    return command !== undefined ? { kind: 'command', command } : undefined;
  }
  if (v.kind === 'edit') {
    const path = str(v.path);
    const oldText = str(v.oldText);
    const newText = str(v.newText);
    if (path === undefined || oldText === undefined || newText === undefined) return undefined;
    return { kind: 'edit', path, oldText, newText, capped: v.capped === true, replaceAll: v.replaceAll === true };
  }
  if (v.kind === 'write') {
    const path = str(v.path);
    const content = str(v.content);
    if (path === undefined || content === undefined) return undefined;
    return { kind: 'write', path, content, capped: v.capped === true, exists: v.exists === true, existingLines: num(v.existingLines) };
  }
  return undefined;
}

export function parseApproval(v: unknown): PendingApproval | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  return {
    id, tool: str(v.tool) ?? 'unknown', detail: str(v.detail) ?? '', input: str(v.input) ?? '',
    expiresAt: num(v.expiresAt),
    risk: parseRisk(v.risk),
    choices: parseChoices(v.choices),
    preview: parsePreview(v.preview),
  };
}

export function parseQueued(v: unknown): QueuedPrompt | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const text = str(v.text);
  return id && text !== undefined ? { id, text } : null;
}

export function parseGrants(v: unknown): ApprovalGrant[] {
  if (!Array.isArray(v)) return [];
  const out: ApprovalGrant[] = [];
  for (const g of v) {
    if (!isRecord(g)) continue;
    const id = str(g.id);
    const label = str(g.label);
    if (id && label) out.push({ id, tool: str(g.tool) ?? '', label, createdAt: num(g.createdAt) ?? 0 });
  }
  return out;
}

export function parseSnapshot(v: unknown): AgentSnapshot | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const events = Array.isArray(v.events) ? v.events.map(parseEvent).filter((e): e is AgentEvent => e !== null) : [];
  return {
    id,
    title: str(v.title) ?? 'session',
    cwd: str(v.cwd) ?? '',
    status: parseStatus(v.status) ?? 'idle',
    lastUsed: num(v.lastUsed) ?? 0,
    createdAt: num(v.createdAt) ?? 0,
    events,
    pending: parseApproval(v.pending),
    queued: parseQueued(v.queued),
    grants: parseGrants(v.grants),
  };
}

/** Messages arrive from the network, so nothing about them is assumed. */
export function parseAgentMessage(raw: unknown): AgentMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'hello': {
      const session = parseSnapshot(value.session);
      return session ? { type: 'hello', session } : null;
    }
    case 'event': {
      const event = parseEvent(value.event);
      return event ? { type: 'event', event } : null;
    }
    case 'status': {
      const status = parseStatus(value.status);
      return status ? { type: 'status', status } : null;
    }
    case 'permission': {
      const request = parseApproval(value.request);
      return request ? { type: 'permission', request } : null;
    }
    case 'permission-clear':
      return { type: 'permission-clear' };
    case 'queued':
      return { type: 'queued', queued: parseQueued(value.queued) };
    case 'grants':
      return { type: 'grants', grants: parseGrants(value.grants) };
    case 'error':
      return { type: 'error', error: str(value.error) ?? 'unknown error' };
    default:
      return null;
  }
}

// --- session state -----------------------------------------------------------

export type Link = 'connecting' | 'open' | 'closed' | 'error';

export interface SessionState {
  readonly snapshot: AgentSnapshot | null;
  readonly events: readonly AgentEvent[];
  readonly status: AgentStatus;
  readonly pending: PendingApproval | null;
  /** The one prompt parked for after this turn, or null. */
  readonly queued: QueuedPrompt | null;
  /** Standing scoped permissions — trust granted must stay trust visible. */
  readonly grants: readonly ApprovalGrant[];
  readonly link: Link;
  /** Latest host-side complaint or local hint, shown above the composer. */
  readonly note: string;
}

export const INITIAL_SESSION: SessionState = Object.freeze({
  snapshot: null,
  events: [],
  status: 'idle',
  pending: null,
  queued: null,
  grants: [],
  link: 'connecting',
  note: '',
});

export type SessionAction =
  | { readonly type: 'message'; readonly message: AgentMessage }
  | { readonly type: 'link'; readonly link: Link }
  | { readonly type: 'note'; readonly note: string };

/** Folds one protocol message or local action into the session view. */
export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'link') {
    if (state.link === action.link) return state;
    return { ...state, link: action.link };
  }
  if (action.type === 'note') return state.note === action.note ? state : { ...state, note: action.note };

  const msg = action.message;
  switch (msg.type) {
    case 'hello':
      return {
        ...state,
        snapshot: msg.session,
        events: msg.session.events.slice(-EVENT_CAP),
        status: msg.session.status,
        pending: msg.session.pending,
        queued: msg.session.queued ?? null,
        grants: msg.session.grants ?? [],
        link: 'open',
        note: '',
      };
    case 'event': {
      const events = state.events.length >= EVENT_CAP
        ? [...state.events.slice(state.events.length - EVENT_CAP + 1), msg.event]
        : [...state.events, msg.event];
      return { ...state, events };
    }
    case 'status':
      return state.status === msg.status ? state : { ...state, status: msg.status };
    case 'permission':
      return { ...state, pending: msg.request, status: 'waiting' };
    case 'permission-clear':
      return state.pending === null ? state : { ...state, pending: null };
    case 'queued':
      return { ...state, queued: msg.queued };
    case 'grants':
      return { ...state, grants: msg.grants };
    case 'error':
      return { ...state, note: msg.error };
  }
}

/** Whether a prompt would run immediately (idle host) rather than queue. */
export function canPrompt(state: SessionState): boolean {
  return state.link === 'open' && state.status !== 'running' && state.status !== 'waiting';
}

/**
 * What pressing the composer's action does right now. The host queues while
 * busy instead of refusing, so the button itself must say which will happen —
 * "Send" and "Queue" are different promises, and mislabelling them is how a
 * queued prompt gets mistaken for a sent one.
 */
export function promptMode(state: SessionState): 'send' | 'queue' | null {
  if (state.link !== 'open') return null;
  return isBusy(state.status) ? 'queue' : 'send';
}

export function isBusy(status: AgentStatus): boolean {
  return status === 'running' || status === 'waiting';
}

/** What the composer row offers right now. */
export interface ComposerControls {
  /** The visible keyboard exit (docs/DESIGN.md §11.2). */
  readonly showDismiss: boolean;
  /** Whether the action button would actually act. */
  readonly canSend: boolean;
  /** The action button's honest label — send now, or queue for after the turn. */
  readonly sendLabel: 'Send' | 'Queue';
  /** Interrupt is only offered while a turn is actually running or waiting. */
  readonly showInterrupt: boolean;
}

/**
 * The dismiss is a function of focus alone — never of `canSend`. Send is
 * disabled exactly when the field is empty or the host is busy, which is
 * exactly when someone most needs to put the keyboard away, so tying the ×
 * to sendability would rebuild the day-one keyboard trap it exists to break.
 */
export function composerControls(focused: boolean, input: string, state: SessionState): ComposerControls {
  const mode = promptMode(state);
  return {
    showDismiss: focused,
    canSend: input.trim().length > 0 && mode !== null,
    sendLabel: mode === 'queue' ? 'Queue' : 'Send',
    showInterrupt: mode === 'queue' && input.trim().length > 0,
  };
}

// --- presentation helpers ----------------------------------------------------

export type StatusTone = 'good' | 'warn' | 'accent' | 'bad';

export function statusTone(s: AgentStatus): StatusTone {
  return s === 'running' ? 'warn' : s === 'waiting' ? 'accent' : s === 'error' ? 'bad' : 'good';
}

export function statusLabel(s: AgentStatus): string {
  return s === 'running' ? 'working' : s === 'waiting' ? 'needs approval' : s === 'error' ? 'error' : 'idle';
}

/** "now", "5m ago", "3h ago", "2d ago". */
export function ago(t: number, now = Date.now()): string {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Last path segment, for either separator. Falls back to the whole path. */
export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

/** The "✓ done · 12s · $0.08" line for a result event. */
export function resultSummary(ev: AgentEvent): string {
  const bits = [
    ev.ok ? '✓ done' : '✗ failed',
    ev.durationMs ? `${Math.round(ev.durationMs / 1000)}s` : '',
    ev.costUsd ? `$${ev.costUsd.toFixed(2)}` : '',
  ];
  return bits.filter(Boolean).join(' · ');
}

export interface DiscoveredGroup {
  readonly cwd: string;
  readonly name: string;
  readonly sessions: readonly DiscoveredSession[];
}

/**
 * Groups discovered sessions by project folder. The host sends them newest
 * first, so groups come out ordered by their most recent session and each
 * group keeps that order inside.
 */
export function groupDiscovered(list: readonly DiscoveredSession[]): DiscoveredGroup[] {
  const groups: { cwd: string; name: string; sessions: DiscoveredSession[] }[] = [];
  for (const d of list) {
    const g = groups.find((x) => x.cwd === d.cwd);
    if (g) g.sessions.push(d);
    else groups.push({ cwd: d.cwd, name: projectName(d.cwd), sessions: [d] });
  }
  return groups;
}

/** Puts a transcript into a composer: appended with a space, never glued on. */
export function appendTranscript(current: string, text: string): string {
  const clip = text.trim();
  if (!clip) return current;
  const base = current.replace(/\s+$/, '');
  return base ? `${base} ${clip}` : clip;
}
