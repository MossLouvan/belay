// Pure state for `/ws/agent-attach`: the wire protocol, the reducer that folds
// it into what the screen shows, and the two judgements the header makes —
// whether another client is driving the size, and whether a dropped socket
// should re-attach. No React and no JSX, so `attach-model.test.mjs` can import
// it straight into Node.
//
// The socket is deliberately the same vocabulary as /ws/terminal, with two
// additions that exist because a pty here has more than one client on it:
//
//   host → client   {type:'ready', mode:'pty', cols, rows, attached, session}
//                   {type:'data', data}          scrollback first, then live
//                   {type:'resize', cols, rows}  the NEGOTIATED minimum size
//                   {type:'exit'} / {type:'error', error}
//   client → host   {type:'data', data} / {type:'resize', cols, rows}
//
// The negotiated size is the whole reason this file has a reducer rather than
// a couple of useStates: what the phone asked for and what it was granted are
// different numbers, everything on screen must lay out to the second, and the
// person holding the phone deserves to be told why it is not the first.

/** Geometry as this client measured it, before the host has had its say. */
export interface AttachSize {
  readonly cols: number;
  readonly rows: number;
}

export interface AttachSessionInfo {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
}

export type AttachMessage =
  | {
      readonly type: 'ready';
      readonly mode: string;
      readonly cols: number;
      readonly rows: number;
      readonly attached: number;
      readonly session: AttachSessionInfo | null;
    }
  | { readonly type: 'data'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'exit' }
  | { readonly type: 'error'; readonly error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const dim = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;

function parseSessionInfo(v: unknown): AttachSessionInfo | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  return { id, title: str(v.title) ?? 'session', cwd: str(v.cwd) ?? '' };
}

/** Messages arrive from the network, so nothing about them is assumed. */
export function parseAttachMessage(raw: unknown): AttachMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'ready': {
      const cols = dim(value.cols);
      const rows = dim(value.rows);
      // A ready without a usable size is not a handshake this screen can lay
      // out to, and guessing one would draw a screenful of wrapped garbage.
      if (cols === null || rows === null) return null;
      const attached = dim(value.attached);
      return {
        type: 'ready',
        mode: str(value.mode) ?? 'pty',
        cols,
        rows,
        attached: attached ?? 1,
        session: parseSessionInfo(value.session),
      };
    }
    case 'data': {
      const data = str(value.data);
      return data === undefined ? null : { type: 'data', data };
    }
    case 'resize': {
      const cols = dim(value.cols);
      const rows = dim(value.rows);
      return cols === null || rows === null ? null : { type: 'resize', cols, rows };
    }
    case 'exit':
      return { type: 'exit' };
    case 'error':
      return { type: 'error', error: str(value.error) ?? 'the session could not be attached' };
    default:
      return null;
  }
}

// --- state -------------------------------------------------------------------

/**
 * The three not-open states are deliberately three, not one:
 *
 *   'closed'  the socket dropped — re-attach, and the host's scrollback replay
 *             puts the screen back exactly as it was.
 *   'exited'  the session's process ended — nothing to replay, and re-attaching
 *             would quietly start a second `claude` nobody asked for.
 *   'error'   the host refused the attach (no such session, not a pty one) —
 *             retrying would fail the same way, every time, forever.
 *
 * Only the first retries by itself. The other two get a visible button.
 */
export type AttachLink = 'connecting' | 'open' | 'closed' | 'error' | 'exited';

export interface AttachState {
  readonly link: AttachLink;
  /** True once `ready` has landed — before it, the size on screen is a guess. */
  readonly ready: boolean;
  /** The size the host granted: the minimum across every attached client. */
  readonly size: AttachSize;
  /** What this client measured and asked for, or null before it has measured. */
  readonly requested: AttachSize | null;
  /** Clients on this pty, this one included. */
  readonly attached: number;
  readonly session: AttachSessionInfo | null;
  /** The latest host complaint, shown rather than swallowed. */
  readonly note: string;
  /** Re-attaches so far without a successful ready, for the retry backoff. */
  readonly retries: number;
}

/** Until the host says otherwise, the same floor the terminal tab starts at. */
export const INITIAL_ATTACH: AttachState = Object.freeze({
  link: 'connecting' as AttachLink,
  ready: false,
  size: Object.freeze({ cols: 80, rows: 24 }),
  requested: null,
  attached: 1,
  session: null,
  note: '',
  retries: 0,
});

export type AttachAction =
  | { readonly type: 'message'; readonly message: AttachMessage }
  | { readonly type: 'link'; readonly link: AttachLink }
  /** This client measured itself; what it asked the host for. */
  | { readonly type: 'requested'; readonly size: AttachSize }
  /**
   * A fresh socket is being opened: the screen is about to be replayed. A
   * `manual` reopen is a person pressing Reattach, which starts the backoff
   * over — they have waited long enough by deciding to press it.
   */
  | { readonly type: 'reopen'; readonly manual?: boolean };

export function reduceAttach(state: AttachState, action: AttachAction): AttachState {
  switch (action.type) {
    case 'link': {
      if (state.link === action.link) return state;
      // A session that ended stays ended: a socket closing afterwards is the
      // consequence, not a new fact, and must not read as a dropped link.
      if (state.link === 'exited' && action.link !== 'connecting') return state;
      // Likewise a refusal: the host said no and then hung up, and the hang-up
      // must not overwrite the reason with a generic "dropped".
      if (state.link === 'error' && action.link === 'closed') return state;
      return { ...state, link: action.link, ready: action.link === 'open' ? state.ready : false };
    }
    case 'requested':
      return state.requested !== null
        && state.requested.cols === action.size.cols
        && state.requested.rows === action.size.rows
        ? state
        : { ...state, requested: action.size };
    case 'reopen':
      return {
        ...state, link: 'connecting', ready: false, note: '',
        retries: action.manual ? 0 : state.retries + 1,
      };
    case 'message': {
      const msg = action.message;
      switch (msg.type) {
        case 'ready':
          return {
            ...state,
            link: 'open',
            ready: true,
            size: { cols: msg.cols, rows: msg.rows },
            attached: msg.attached,
            session: msg.session ?? state.session,
            note: '',
            // A handshake is the only proof the link actually works, so it —
            // not a socket that merely opened — is what resets the backoff.
            retries: 0,
          };
        case 'resize':
          return state.size.cols === msg.cols && state.size.rows === msg.rows
            ? state
            : { ...state, size: { cols: msg.cols, rows: msg.rows } };
        case 'exit':
          return { ...state, link: 'exited', ready: false };
        case 'error':
          return { ...state, link: 'error', ready: false, note: msg.error };
        case 'data':
          // Output is fed to the parser by the caller, not held in this state:
          // a screen buffer in a reducer would re-render on every byte.
          return state;
      }
    }
  }
}

// --- what the header says ----------------------------------------------------

/**
 * Why the terminal is narrower than this phone can draw, when it is.
 *
 * The host hands every attached client the minimum size across all of them, so
 * a small window at the desk shrinks the phone. That is correct — one pty
 * cannot be two sizes — but an unexplained 80×24 on a screen that measured
 * 120×40 looks like a bug, so it is named. Silent when this phone is the only
 * client: then the size it was granted is the size it asked for, and any
 * difference is the host's own floor, not another person.
 */
export function sizeNote(state: AttachState, reported?: number): string | null {
  const req = state.requested;
  if (!state.ready || !req) return null;
  if (effectiveAttached(state, reported) <= 1) return null;
  if (state.size.cols >= req.cols && state.size.rows >= req.rows) return null;
  return `sized to the desk terminal · ${state.size.cols}×${state.size.rows}`;
}

/**
 * "someone else is looking at this", from a client count — or nothing.
 *
 * One attached client is this one and is not news. Shared with the session
 * list (session-kind.ts), which learns the same count from REST instead of
 * from the socket, so the two surfaces can never word it differently.
 */
export function othersAttached(attached: number | undefined): string | null {
  if (typeof attached !== 'number' || !Number.isFinite(attached) || attached <= 1) return null;
  const others = Math.floor(attached) - 1;
  return others === 1 ? '1 other attached' : `${others} others attached`;
}

/**
 * How many clients are on this pty right now.
 *
 * `ready` carries the count at the instant this client attached and is never
 * updated afterwards — the protocol has no message for it, because the size is
 * the only negotiated thing the pty itself cares about. The session list's
 * count comes from the host's registry on every poll, so when one is in hand it
 * is the fresher of the two and wins. Without it the handshake's number is all
 * there is, which is right for the first few seconds and stale after that.
 */
export function effectiveAttached(state: AttachState, reported?: number): number {
  return typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? Math.floor(reported)
    : state.attached;
}

/** The same, for a live attachment: silent until the handshake has landed. */
export function attachedNote(state: AttachState, reported?: number): string | null {
  return state.ready ? othersAttached(effectiveAttached(state, reported)) : null;
}

/**
 * The command to run AT the computer to join this same session.
 *
 * The desk half of the feature was documented only in docs/AGENT.md, which
 * means the user who most needs it — the one holding the phone, looking at a
 * session he would rather be typing into on a real keyboard — had no way to
 * discover it existed. It is one line, it is exact, and it belongs on the
 * screen that makes you want it.
 */
export function deskCommand(id: string): string {
  return `npm run attach -- ${id}`;
}

/** The header's one-line truth about the link, for a screen that must never look dead. */
export function linkLabel(state: AttachState): string {
  switch (state.link) {
    case 'open':
      return state.ready ? 'live' : 'attaching';
    case 'connecting':
      return state.retries > 0 ? 'reattaching' : 'attaching';
    case 'exited':
      return 'ended';
    case 'error':
      return 'failed';
    case 'closed':
      return 'reattaching';
  }
}

// --- reconnect ---------------------------------------------------------------

/**
 * Backoff for re-attaching. Short at first because the common drop is a phone
 * that slept for a moment, longer after that because the uncommon one is a
 * host that is gone and hammering it helps nobody.
 */
export const RETRY_DELAYS_MS: readonly number[] = [400, 800, 1600, 3200, 6000];

export function retryDelay(retries: number): number {
  const i = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Math.floor(retries)));
  return RETRY_DELAYS_MS[i];
}

/**
 * Whether a dropped link should re-attach by itself. Only a socket that
 * dropped: the host replays the scrollback on attach, so a reconnect restores
 * the screen rather than leaving a dead one. A refusal and an exit are
 * answered by a button, because repeating either would be a loop.
 */
export function shouldReattach(state: Pick<AttachState, 'link'>): boolean {
  return state.link === 'closed';
}
