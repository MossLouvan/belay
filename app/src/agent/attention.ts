// Pure logic for "a session needs you": which sessions are waiting on an
// approval, which one to surface first, and how to say how long is left.
// No React and no react-native, so `attention.test.mjs` runs it in plain Node —
// same contract as model.ts.

import type { AgentSessionMeta } from '../api';

/**
 * How often the app re-reads the session list while it is on screen. Three
 * seconds is the compromise between "the badge lies" and hammering a host
 * that is also busy encoding video: the list endpoint is a single in-memory
 * map walk, so this is cheap on both ends.
 */
export const ATTENTION_POLL_MS = 3000;

/** Poll cadence once a fetch has failed — no point retrying a dead link hard. */
export const ATTENTION_RETRY_MS = 10000;

/**
 * The sessions blocked on a human, soonest-to-expire first so the one about
 * to die unanswered is the one the banner shows. A row counts as waiting on
 * either signal — `status === 'waiting'` or a pending summary — because an
 * older host sends only the status, and a race between the two fields must
 * not hide a live ask.
 */
export function waitingSessions(sessions: readonly AgentSessionMeta[]): readonly AgentSessionMeta[] {
  return sessions
    .filter((s) => s.status === 'waiting' || (s.pending !== undefined && s.pending !== null))
    .sort((a, b) => (a.pending?.expiresAt ?? Infinity) - (b.pending?.expiresAt ?? Infinity));
}

/**
 * "28:41", "1:02:03", "0:07" — how long until the ask auto-denies. Empty when
 * there is no deadline (the host is configured to wait forever) and "0:00"
 * once it has passed, never a negative number: past-expiry the host has
 * already denied and the next poll will clear the ask.
 */
export function countdown(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return '';
  const total = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Under two minutes left: the countdown should turn urgent. */
export function expiryUrgent(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt - now < 2 * 60 * 1000;
}

/**
 * The line under the banner's title: the tool and its one-line detail,
 * trimmed so the banner never wraps into a paragraph.
 */
export function askSummary(tool: string, detail: string, max = 80): string {
  const joined = detail ? `${tool}  ${detail}` : tool;
  return joined.length > max ? joined.slice(0, max - 1) + '…' : joined;
}
