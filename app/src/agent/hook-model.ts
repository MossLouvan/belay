// Pure logic for terminal-session asks — the permission requests a `claude`
// running in a terminal forwards through the host's Claude Code hook. The
// push socket carries a thin row per ask/notice; this file parses that half
// of the frame, folds it into the last fetched list, and shapes the rows for
// the list, the badge and the transcript view. No React, no react-native, so
// `hook-model.test.mjs` runs it in plain Node — same contract as model.ts.

import type { DiscoveredSession, HookList, HookNotice, HookPermission } from '../api';
import { projectName } from './model.ts';

/** One pushed hook row — id and kind are all the badge needs. */
export interface HookPushRow {
  readonly id: string;
  readonly kind: 'permission' | 'done' | 'terminal-prompt';
  readonly sessionId: string;
  readonly createdAt: number;
}

const KINDS = new Set(['permission', 'done', 'terminal-prompt']);

/**
 * The `hooks` half of an attention frame. `null` means the host did not send
 * one (older host, or a malformed list) — the store then leaves its hook
 * list alone. Never a partial list: one bad row voids the frame's half.
 */
export function parseHooksPush(raw: string): readonly HookPushRow[] | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (typeof msg !== 'object' || msg === null) return null;
  const { type, hooks } = msg as { type?: unknown; hooks?: unknown };
  if (type !== 'attention' || !Array.isArray(hooks)) return null;
  const rows: HookPushRow[] = [];
  for (const r of hooks as { id?: unknown; kind?: unknown; sessionId?: unknown; createdAt?: unknown }[]) {
    if (typeof r?.id !== 'string' || typeof r?.kind !== 'string' || !KINDS.has(r.kind)) return null;
    if (typeof r.sessionId !== 'string') return null;
    rows.push({
      id: r.id,
      kind: r.kind as HookPushRow['kind'],
      sessionId: r.sessionId,
      createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    });
  }
  return rows;
}

const EMPTY_HOOKS: HookList = Object.freeze({ permissions: [], notices: [] }) as HookList;

/**
 * Fold pushed hook rows into the last fetched list. An ask or notice the
 * push no longer lists (decided, withdrawn, dismissed, expired) drops at
 * once — the badge must not wait on a round trip to stop counting it. An id
 * the list has never seen carries a tool, input and choices the row cannot,
 * so it comes back as `needsFetch`. Unchanged lists keep identity.
 */
export function applyHooksPush(
  current: HookList | null,
  rows: readonly HookPushRow[],
): { readonly hooks: HookList | null; readonly needsFetch: boolean } {
  if (current === null) return { hooks: null, needsFetch: rows.length > 0 };
  const listed = new Set(rows.map((r) => r.id));
  const known = new Set([...current.permissions.map((p) => p.id), ...current.notices.map((n) => n.id)]);
  const needsFetch = rows.some((r) => !known.has(r.id));
  const permissions = current.permissions.filter((p) => listed.has(p.id));
  const notices = current.notices.filter((n) => listed.has(n.id));
  const changed = permissions.length !== current.permissions.length || notices.length !== current.notices.length;
  if (!changed) return { hooks: current, needsFetch };
  const hooks = permissions.length === 0 && notices.length === 0 ? EMPTY_HOOKS : { permissions, notices };
  return { hooks, needsFetch };
}

/** How many terminal asks are blocked on this phone — added to the badge. */
export function hookWaitingCount(hooks: HookList | null): number {
  return hooks?.permissions.length ?? 0;
}

/** Oldest first: the ask that has waited longest is answered first. */
export function orderedHookAsks(hooks: HookList | null): readonly HookPermission[] {
  return [...(hooks?.permissions ?? [])].sort((a, b) => a.createdAt - b.createdAt);
}

/** "belay" for /Users/me/projects/belay — how the card names the session. */
export function hookTitle(item: { readonly cwd: string }): string {
  return projectName(item.cwd);
}

/**
 * The ask's session as a DiscoveredSession, so tapping the card opens the
 * same read-only transcript view the "On this PC" list uses. The preview is
 * the ask itself — the tool and what it wants — until the transcript loads.
 */
export function discoveredFromHook(item: HookPermission | HookNotice): DiscoveredSession {
  const preview = 'tool' in item ? `${item.tool}  ${item.detail}` : item.text;
  return {
    claudeSessionId: item.sessionId,
    cwd: item.cwd,
    mtime: item.createdAt,
    lastWriteAt: item.createdAt,
    live: true,
    preview,
  };
}

/** The one-line notice row: "done" / "waiting at the terminal", with the tail. */
export function noticeLine(notice: HookNotice, max = 90): { readonly label: string; readonly text: string } {
  const label = notice.kind === 'done' ? 'done' : 'prompt waiting at the terminal';
  const text = notice.text.replace(/\s+/g, ' ').trim();
  return { label, text: text.length > max ? text.slice(0, max - 1) + '…' : text };
}
