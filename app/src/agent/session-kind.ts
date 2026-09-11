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
