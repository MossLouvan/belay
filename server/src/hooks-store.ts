// Permission asks from sessions Belay did not spawn. A `claude` started in a
// terminal fires a PermissionRequest hook the moment it wants to run a tool;
// hooks/belay-hook.mjs forwards the ask here and waits. This store holds
// every such ask until the phone decides it or the hook gives up, plus the
// lighter notices (a turn finished, a prompt is sitting at the terminal)
// that ride the same attention channel.
//
// State is one frozen object replaced on every change, keyed by
// `<sessionId>:<requestId>` — never mutated, so a snapshot handed to the wire
// is exactly what it was when taken. The card fields (risk, preview, detail)
// are minted by the same functions the Belay-spawned flow uses, so the phone
// renders both kinds of ask with one component and one set of rules.
//
// Nothing here auto-allows. The only outcomes are: the phone said allow, the
// phone said deny, or nobody said anything and the hook stands down — which
// Claude Code turns into its ordinary terminal prompt.

import { toolDetail } from './agent-events.js';
import { buildPreview } from './approval-preview.js';
import type { ApprovalPreview } from './approval-preview.js';
import { riskTier } from './approval-scopes.js';
import type { RiskTier, ScopeChoice } from './approval-scopes.js';
import type { HookEvent, PermissionRequestEvent, PermissionRuleUpdate } from './hooks-validate.js';

/** What the hook prints for Claude Code — `decision` in the hook's own vocabulary. */
export type HookDecision =
  | { readonly behavior: 'allow'; readonly updatedPermissions?: readonly PermissionRuleUpdate[] }
  | { readonly behavior: 'deny'; readonly message: string };

/** A "suggest-N" choice: N indexes the ask's own suggestions list. */
export interface HookChoice {
  readonly id: string;
  readonly label: string;
}

/** One ask on the wire: the PendingApproval shape plus where it came from. */
export interface HookPermission {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly tool: string;
  readonly detail: string;
  readonly input: string;
  readonly risk: RiskTier;
  readonly choices: readonly HookChoice[];
  readonly preview?: ApprovalPreview;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type HookNoticeKind = 'terminal-prompt' | 'done';

export interface HookNotice {
  readonly id: string;
  readonly kind: HookNoticeKind;
  readonly sessionId: string;
  readonly cwd: string;
  readonly text: string;
  readonly createdAt: number;
}

/** The thin row the attention socket carries. */
export interface HookRow {
  readonly id: string;
  readonly kind: 'permission' | HookNoticeKind;
  readonly sessionId: string;
  readonly createdAt: number;
}

interface PendingEntry {
  readonly item: HookPermission;
  readonly suggestions: readonly PermissionRuleUpdate[];
  readonly resolve: (d: HookDecision | null) => void;
}

interface HooksState {
  readonly pending: ReadonlyMap<string, PendingEntry>;
  readonly notices: readonly HookNotice[];
}

export interface HooksStoreDeps {
  readonly now?: () => number;
  readonly newId?: () => string;
  /** How long a notice stays listed before it is swept. */
  readonly noticeTtlMs?: number;
}

export interface HooksStore {
  raise(event: PermissionRequestEvent, waitMs: number): { readonly item: HookPermission; readonly decision: Promise<HookDecision | null> };
  decide(id: string, allow: boolean, choiceId?: string): boolean;
  /** The hook stopped waiting (timeout, disconnect): the ask can no longer be answered. */
  withdraw(id: string): void;
  notice(event: HookEvent): void;
  dismiss(id: string): boolean;
  pending(): readonly HookPermission[];
  notices(): readonly HookNotice[];
  onChange(fn: () => void): () => void;
}

const INPUT_PRETTY_CAP = 4000;
const DEFAULT_NOTICE_TTL_MS = 30 * 60 * 1000;
const DENY_MESSAGE = 'Denied from the phone (Belay). Ask before trying an equivalent.';

const keyOf = (sessionId: string, id: string): string => `${sessionId}:${id}`;

/** `Bash(npm test)` / `Read` — the rule as Claude Code itself would print it. */
function ruleLabel(rule: { readonly toolName: string; readonly ruleContent?: string }): string {
  return rule.ruleContent === undefined ? `every ${rule.toolName}` : `${rule.toolName}(${rule.ruleContent})`;
}

/**
 * The "always allow…" options for a terminal ask: each allow-suggestion
 * Claude Code itself proposed, offered for this session only. The danger
 * tier gets none, for the same reason Belay's own asks get none.
 */
export function choicesFromSuggestions(
  tool: string, input: unknown, cwd: string, suggestions: readonly PermissionRuleUpdate[],
): readonly HookChoice[] {
  if (riskTier(tool, input, cwd) === 'danger') return [];
  return suggestions.flatMap((s, i): HookChoice[] => {
    if (s.behavior !== 'allow' || s.rules.length === 0) return [];
    const label = `Always allow ${s.rules.map(ruleLabel).join(', ')} (this session)`;
    return [{ id: `suggest-${i}`, label }];
  });
}

/** Claude Code's stdout contract for a PermissionRequest hook; `{}` means "no decision". */
export function decisionOutput(decision: HookDecision | null): Record<string, unknown> {
  if (!decision) return {};
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

export function hookRows(store: HooksStore): readonly HookRow[] {
  return [
    ...store.pending().map((p): HookRow => ({ id: p.id, kind: 'permission', sessionId: p.sessionId, createdAt: p.createdAt })),
    ...store.notices().map((n): HookRow => ({ id: n.id, kind: n.kind, sessionId: n.sessionId, createdAt: n.createdAt })),
  ];
}

export function createHooksStore(deps: HooksStoreDeps = {}): HooksStore {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => Math.random().toString(36).slice(2, 12));
  const ttl = deps.noticeTtlMs ?? DEFAULT_NOTICE_TTL_MS;
  let state: HooksState = { pending: new Map(), notices: [] };
  const listeners = new Set<() => void>();

  const setState = (next: HooksState): void => {
    state = next;
    for (const fn of listeners) { try { fn(); } catch { /* a listener must not break the store */ } }
  };
  const fresh = (list: readonly HookNotice[]): readonly HookNotice[] =>
    list.filter((n) => n.createdAt + ttl > now());
  const without = (map: ReadonlyMap<string, PendingEntry>, key: string): ReadonlyMap<string, PendingEntry> =>
    new Map([...map].filter(([k]) => k !== key));
  const findKey = (id: string): string | undefined =>
    [...state.pending.keys()].find((k) => k.endsWith(`:${id}`));

  const settle = (id: string, decision: HookDecision | null): boolean => {
    const key = findKey(id);
    if (!key) return false;
    const entry = state.pending.get(key);
    if (!entry) return false;
    setState({ ...state, pending: without(state.pending, key) });
    entry.resolve(decision);
    return true;
  };

  const addNotice = (notice: HookNotice): void => {
    // One notice per session: the newest fact replaces the older one.
    const kept = fresh(state.notices).filter((n) => n.sessionId !== notice.sessionId);
    setState({ ...state, notices: [notice, ...kept] });
  };

  return {
    raise(event, waitMs) {
      const id = newId();
      const t = now();
      const { toolName: tool, toolInput, cwd } = event;
      const pretty = JSON.stringify(toolInput ?? {}, null, 2);
      const item: HookPermission = {
        id, sessionId: event.sessionId, cwd, tool,
        detail: toolDetail(tool, toolInput),
        input: pretty.length > INPUT_PRETTY_CAP ? pretty.slice(0, INPUT_PRETTY_CAP) + '…' : pretty,
        risk: riskTier(tool, toolInput, cwd),
        choices: choicesFromSuggestions(tool, toolInput, cwd, event.suggestions),
        preview: buildPreview(tool, toolInput, cwd),
        createdAt: t,
        expiresAt: t + waitMs,
      };
      let resolve: (d: HookDecision | null) => void = () => {};
      const decision = new Promise<HookDecision | null>((r) => { resolve = r; });
      const entry: PendingEntry = { item, suggestions: event.suggestions, resolve };
      // A "prompt is waiting at the terminal" notice for this session is now
      // superseded by the ask itself.
      const notices = fresh(state.notices).filter((n) => !(n.sessionId === event.sessionId && n.kind === 'terminal-prompt'));
      setState({ pending: new Map([...state.pending, [keyOf(event.sessionId, id), entry]]), notices });
      return { item, decision };
    },

    decide(id, allow, choiceId) {
      const key = findKey(id);
      const entry = key ? state.pending.get(key) : undefined;
      if (!entry) return false;
      if (!allow) return settle(id, { behavior: 'deny', message: DENY_MESSAGE });
      const offered = entry.item.choices.find((c) => c.id === choiceId);
      const index = offered ? Number(offered.id.slice('suggest-'.length)) : -1;
      const suggestion = index >= 0 ? entry.suggestions[index] : undefined;
      // The grant is minted from the suggestion Claude Code sent, never from
      // the wire, and always in memory only — a phone tap must not write
      // settings files on the computer.
      return settle(id, suggestion
        ? { behavior: 'allow', updatedPermissions: [{ ...suggestion, destination: 'session' }] }
        : { behavior: 'allow' });
    },

    withdraw(id) { settle(id, null); },

    notice(event) {
      if (event.kind === 'Stop') {
        if (event.stopHookActive) return;
        addNotice({ id: newId(), kind: 'done', sessionId: event.sessionId, cwd: event.cwd, text: event.lastAssistantMessage, createdAt: now() });
      } else if (event.kind === 'Notification' && event.notificationType === 'permission_prompt') {
        addNotice({ id: newId(), kind: 'terminal-prompt', sessionId: event.sessionId, cwd: event.cwd, text: event.message, createdAt: now() });
      }
    },

    dismiss(id) {
      const kept = fresh(state.notices).filter((n) => n.id !== id);
      const found = kept.length !== fresh(state.notices).length;
      setState({ ...state, notices: kept });
      return found;
    },

    pending() { return [...state.pending.values()].map((e) => e.item); },
    notices() { return fresh(state.notices); },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

// The production store. Lazy so importing this module for its pure functions
// (tests) never touches process-wide state.
let defaultStore: HooksStore | null = null;

/** The one store index.ts, the routes and the attention hub share. */
export function hooksStore(): HooksStore {
  defaultStore ??= createHooksStore();
  return defaultStore;
}
