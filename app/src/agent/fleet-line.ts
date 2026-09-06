// The one-line agent readout under a computer's name on the computers list:
// `2 RUNNING · 1 WAITING · 1 LIVE`. Pure — counts from the attention store's
// two lists, nothing rendered. Null when there is nothing worth a line, so
// the card shows no placeholder; the caller decides whether the store's data
// even belongs to this computer.

import type { AgentSessionMeta, DiscoveredSession } from '../api';
import { waitingSessions } from './attention.ts';

export interface FleetLine {
  /** Mono, uppercase, parts joined by ` · `. */
  readonly text: string;
  /** Someone on the computer is blocked on this phone — the accent's cue. */
  readonly warn: boolean;
}

const SEP = ' · ';

/**
 * Counts: Belay sessions running / waiting, plus terminal-started sessions a
 * terminal is writing to right now (`live`). Idle and errored sessions are
 * not counted — the line is about what is happening, not what exists. A
 * session with a pending approval is WAITING whatever its status says, the
 * same rule the badge uses.
 */
export function fleetLine(
  sessions: readonly AgentSessionMeta[] | null,
  discovered: readonly DiscoveredSession[] | null,
): FleetLine | null {
  const list = sessions ?? [];
  const waitingIds = new Set(waitingSessions(list).map((s) => s.id));
  const waiting = waitingIds.size;
  const running = list.filter((s) => s.status === 'running' && !waitingIds.has(s.id)).length;
  const live = (discovered ?? []).filter((d) => d.live === true).length;

  const parts = [
    running > 0 ? `${running} RUNNING` : null,
    waiting > 0 ? `${waiting} WAITING` : null,
    live > 0 ? `${live} LIVE` : null,
  ].filter((p): p is string => p !== null);

  if (parts.length === 0) return null;
  return { text: parts.join(SEP), warn: waiting > 0 };
}
