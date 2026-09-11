// Which of the two session shapes a row or a screen is looking at, and the
// handful of facts the UI derives from it. No React and no JSX, so
// `session-kind.test.mjs` can import it straight into Node.
//
// The distinction matters everywhere the phone touches a session:
//
//   'pty'    — a real interactive `claude` in a terminal the host owns. The
//              phone is one attached client among however many; the desk can
//              join the same live session and nothing restarts.
//   'stream' — the original structured feed: the host drives `claude` over
//              pipes and every action stops at an approval card on the phone.
//
// A host from before attachable sessions sends no `kind` at all, and
// everything it runs is a stream session. That absence is turned into a value
// here and nowhere else, so no screen has to remember which way to guess.

import type { AgentSessionKind, AgentSessionMeta } from '../api';

/** The shape enough of a session to decide any of this. */
export interface KindBearing {
  readonly id?: string;
  readonly kind?: AgentSessionKind;
  readonly attached?: number;
  readonly live?: boolean;
}

/** Sessions from a host that predates `kind` were all stream-json. */
export function sessionKind(meta: KindBearing | null | undefined): AgentSessionKind {
  return meta?.kind === 'pty' ? 'pty' : 'stream';
}

/**
 * Whether opening this session means attaching to a live terminal. Only Belay's
 * own pty sessions qualify: a `claude` someone started by typing it themselves
 * is watched through the transcript and answered through the hook, and offering
 * an Attach on one would promise a terminal that does not exist.
 */
export function isAttachable(meta: KindBearing | null | undefined): boolean {
  return sessionKind(meta) === 'pty';
}

/** The word for the kind, in the list's voice. */
export function kindLabel(kind: AgentSessionKind): string {
  return kind === 'pty' ? 'terminal' : 'guided';
}

/**
 * "someone is looking at this", for a row in the session list.
 *
 * Deliberately not the session view's wording. On the list this phone is *not*
 * one of the attached clients — the view it would be counted in is closed — so
 * every client the host reports is somebody else, and subtracting one the way
 * the header does would hide the single desk terminal that is the whole point
 * of saying it. A plain count, never a claim about who: the number comes from
 * the host's registry, and an absent one degrades to silence.
 */
export function attachedLabel(meta: KindBearing | null | undefined): string | null {
  if (!isAttachable(meta)) return null;
  const n = meta?.attached;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return null;
  return `${Math.floor(n)} attached`;
}

/**
 * Whether this pty session's process is running on the computer right now.
 *
 * `live` is only meaningful for a pty session; a stream session's own status
 * word already says everything there is to say about it. An older host sends
 * no `live` at all, and "I was not told" is not "no" — hence the explicit
 * boolean check rather than a truthiness test.
 */
export function isLive(meta: KindBearing | null | undefined): boolean {
  return isAttachable(meta) && meta?.live === true;
}

/**
 * The list row's one-line state for a pty session: the fact that decides what
 * tapping it will do.
 *
 * A running pty and a killed one used to render identically — same grey dot,
 * same "terminal", same timestamp — so the list could not tell a session
 * someone is typing into from one that has been dead for an hour. The desk CLI
 * has always said it plainly ("live · 1 attached" / "stopped") and the data was
 * already on every row; this is the same sentence, from the same numbers.
 *
 * `null` for a stream session, and for a host too old to have sent `live` —
 * silence rather than a guess.
 */
export function ptyStateLabel(meta: KindBearing | null | undefined): string | null {
  if (!isAttachable(meta) || typeof meta?.live !== 'boolean') return null;
  if (!meta.live) return 'stopped';
  const who = attachedLabel(meta);
  return who ? `live · ${who}` : 'live';
}

/**
 * How many sessions are actually working — the list's RUNNING stat.
 *
 * A pty session's `status` is about its stream-json twin and stays 'idle' while
 * a human types into it, so counting statuses alone read 0 over a live
 * terminal. A pty counts when its process is up; everything else counts when
 * its status says so.
 */
export function runningCount(sessions: readonly KindBearing[] | null | undefined): number {
  if (!sessions) return 0;
  let n = 0;
  for (const s of sessions) {
    if (isAttachable(s)) { if (isLive(s)) n += 1; }
    else if ((s as { status?: string }).status === 'running') n += 1;
  }
  return n;
}

/**
 * What starting this pty session again will actually do.
 *
 * The screen used to promise "a fresh one in this folder" on every ended
 * session, which is wrong whenever the host knows the conversation: it will
 * `--resume` it and pick up exactly where it stopped. Both answers are true
 * somewhere, so the host's `resumable` decides, and an older host that never
 * sends it gets the sentence that claims the least.
 */
export function restartNote(meta: KindBearing & { resumable?: boolean } | null | undefined): string {
  if (meta?.resumable === true) return 'Starting it again resumes this same conversation where it left off.';
  if (meta?.resumable === false) return 'The computer never identified this conversation, so starting it again begins a fresh one in this folder.';
  return 'Starting it again reopens the session on the computer.';
}

/**
 * The kind of a session id, from a list already in hand. `null` means "not in
 * this list" — which is not the same as 'stream', and callers must fetch
 * rather than render a feed over a live terminal.
 */
export function pickKind(
  sessions: readonly AgentSessionMeta[] | null | undefined,
  id: string,
): AgentSessionKind | null {
  const found = sessions?.find((s) => s.id === id);
  return found ? sessionKind(found) : null;
}
