// The handoff response, narrowed — and the words the screen says about it.
// Pure and JSX-free so the outcome logic is testable under node: which of the
// host's answers means "a window is open over there", which means "you have to
// paste this yourself", and which means "the phone is still driving this
// session and nothing was touched".

/** What the host did (or refused to do) with a handoff request. */
export type HandoffOutcome =
  | { readonly kind: 'opened'; readonly terminal: string; readonly stopped: boolean; readonly command: string }
  | { readonly kind: 'fallback'; readonly command: string; readonly reason: string }
  | { readonly kind: 'busy'; readonly status: string; readonly command: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value ? value : fallback;

/**
 * Narrow the host's answer. Anything that is neither a recognised outcome nor
 * a carried error becomes a thrown Error, so the screen's error state — not a
 * half-rendered success — is what a version-drifted host produces.
 */
export function parseHandoff(status: number, body: unknown): HandoffOutcome {
  const b = isRecord(body) ? body : {};
  const command = str(b.command, '');

  if (status === 409 && b.busy === true && command) {
    return { kind: 'busy', status: str(b.status, 'running'), command };
  }
  if (status >= 200 && status < 300 && command) {
    if (b.opened === true) {
      return { kind: 'opened', terminal: str(b.terminal, 'a terminal'), stopped: b.stopped === true, command };
    }
    if (b.opened === false) {
      return { kind: 'fallback', command, reason: str(b.reason, 'this computer could not open a terminal') };
    }
  }
  throw new Error(str(b.error, `the computer answered strangely (${status})`));
}

/**
 * The busy explanation, in full, before anything happens (§11.4: the observed
 * truth and the consequence, named up front). "waiting" means an approval is
 * sitting unanswered — stopping denies it, which is worth saying.
 */
export function busyExplanation(status: string): string {
  const doing = status === 'waiting'
    ? 'is waiting for an approval on this phone. Handing off will deny that ask and stop it here'
    : 'is running under Tether right now. Handing off will stop it here, mid-task';
  return `This session ${doing} — two windows driving one Claude chat corrupt its history, so the phone side always lets go first. The terminal picks up the same conversation.`;
}

/** The line under a successful open. Names what happened to the phone side. */
export function openedNote(terminal: string, stopped: boolean): string {
  const released = stopped
    ? 'This phone stopped its side first'
    : 'This phone let go of its side';
  return `${released} — the ${terminal} window on the computer now owns the conversation. Prompting from here again resumes from this point, without whatever you do over there.`;
}
