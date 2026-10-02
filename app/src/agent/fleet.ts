// The control room's one list: every agent the host knows about — Belay's
// own sessions, terminal sessions that asked through the hook, and sessions
// found on disk — folded into one row per session and sorted so what needs
// you is at the top. Pure (no React) so `fleet.test.mjs` runs it in Node.

import type { AgentSessionMeta, DiscoveredSession, HookList, HookNotice, HookPermission } from '../api';
import { waitingSessions } from './attention.ts';
import { orderedHookAsks } from './hook-model.ts';
import { projectName } from './model.ts';
import { isLive, sessionKind } from './session-kind.ts';

export type FleetState = 'waiting' | 'running' | 'done' | 'quiet' | 'error';
export type FleetSource = 'belay' | 'hook' | 'disk';

export interface FleetRow {
  /** Belay session id, or the Claude session id for hook/disk rows. */
  readonly key: string;
  readonly source: FleetSource;
  readonly state: FleetState;
  readonly title: string;
  readonly cwd: string;
  /** Last activity, ms epoch — the tiebreaker within a state. */
  readonly at: number;
  readonly session?: AgentSessionMeta;
  readonly discovered?: DiscoveredSession;
  /** The oldest terminal ask on this session, answered first. */
  readonly ask?: HookPermission;
  /** Terminal asks queued behind `ask`. */
  readonly moreAsks: number;
  readonly notice?: HookNotice;
}

const RANK: Readonly<Record<FleetState, number>> = { waiting: 0, running: 1, error: 2, done: 3, quiet: 4 };

const belayState = (s: AgentSessionMeta, waiting: boolean): FleetState => {
  if (waiting) return 'waiting';
  if (s.status === 'error') return 'error';
  if (s.status === 'running' || (sessionKind(s) === 'pty' && isLive(s))) return 'running';
  return 'quiet';
};

/** Asks grouped by session: oldest first, so the head is the one to answer. */
function asksBySession(hooks: HookList | null): Map<string, readonly HookPermission[]> {
  const out = new Map<string, HookPermission[]>();
  for (const a of orderedHookAsks(hooks)) out.set(a.sessionId, [...(out.get(a.sessionId) ?? []), a]);
  return out;
}

export function fleetRows(
  sessions: readonly AgentSessionMeta[] | null,
  discovered: readonly DiscoveredSession[] | null,
  hooks: HookList | null,
): readonly FleetRow[] {
  const asks = asksBySession(hooks);
  const doneBySession = new Map((hooks?.notices ?? []).filter((n) => n.kind === 'done').map((n) => [n.sessionId, n]));
  const waitingIds = new Set(waitingSessions(sessions ?? []).map((s) => s.id));
  const claimed = new Set<string>();

  const belay = (sessions ?? []).map((s): FleetRow => {
    // A pty session Belay spawned asks through the hook too; its ask rides
    // this row rather than making a second one for the same terminal.
    const own = [...asks.entries()].find(([, list]) => list[0]?.belaySessionId === s.id);
    if (own) claimed.add(own[0]);
    const ask = own?.[1][0];
    return {
      key: s.id, source: 'belay', state: belayState(s, waitingIds.has(s.id) || ask !== undefined),
      title: s.title, cwd: s.cwd, at: s.lastUsed, session: s, ask, moreAsks: own ? own[1].length - 1 : 0,
    };
  });

  const hook = [...asks.entries()].filter(([id]) => !claimed.has(id)).map(([id, list]): FleetRow => {
    claimed.add(id);
    const [ask] = list;
    return { key: id, source: 'hook', state: 'waiting', title: projectName(ask.cwd), cwd: ask.cwd, at: ask.createdAt, ask, moreAsks: list.length - 1 };
  });

  const disk = (discovered ?? []).filter((d) => !claimed.has(d.claudeSessionId)).map((d): FleetRow => {
    claimed.add(d.claudeSessionId);
    const notice = doneBySession.get(d.claudeSessionId);
    const state: FleetState = d.live ? 'running' : notice ? 'done' : 'quiet';
    return { key: d.claudeSessionId, source: 'disk', state, title: projectName(d.cwd), cwd: d.cwd, at: d.lastWriteAt ?? d.mtime, discovered: d, notice, moreAsks: 0 };
  });

  // A turn that finished in a session nothing else lists still deserves a row.
  const finished = [...doneBySession.values()].filter((n) => !claimed.has(n.sessionId)).map((n): FleetRow => ({
    key: n.sessionId, source: 'hook', state: 'done', title: projectName(n.cwd), cwd: n.cwd, at: n.createdAt, notice: n, moreAsks: 0,
  }));

  return [...belay, ...hook, ...disk, ...finished].sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at);
}

export interface FleetCounts {
  readonly running: number;
  readonly waiting: number;
  readonly doneToday: number;
}

/** Local midnight before `now`. */
const startOfDay = (now: number): number => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

/** The strip's numbers, over every source. */
export function fleetCounts(
  sessions: readonly AgentSessionMeta[] | null,
  discovered: readonly DiscoveredSession[] | null,
  hooks: HookList | null,
  now: number,
): FleetCounts {
  const rows = fleetRows(sessions, discovered, hooks);
  const since = startOfDay(now);
  return {
    running: rows.filter((r) => r.state === 'running').length,
    waiting: rows.filter((r) => r.state === 'waiting').length,
    doneToday: (hooks?.notices ?? []).filter((n) => n.kind === 'done' && n.createdAt >= since).length,
  };
}
