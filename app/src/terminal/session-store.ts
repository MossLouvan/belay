// The terminal session, held at module level — the same pattern as the agent
// attention store — so the shell outlives the Terminal route (#90).
//
// The bottom bar REPLACES one tool route with another, which unmounts the
// Terminal screen. When the socket lived in that screen's effect, every tab
// switch closed it and the host ended the shell: scrollback, cwd and running
// commands gone. Here the socket, the parsed screen buffer, the output
// backpressure buffer and the command history belong to the app, keyed on
// the connection they were opened against. The screen subscribes with
// `useSyncExternalStore` and the session ends only on an explicit reopen, a
// different host, or the host dropping it.
//
// No react-native import on purpose: the opener is injected, so the store is
// a plain module that a node test can drive with a fake socket.

import { clearTermState, createTermState, feed } from '../terminal-ansi.ts';
import type { TermOptions, TermState } from '../terminal-ansi.ts';
import { EMPTY_OUTPUT, FLUSH_MS, drainOutput, parseServerMessage, pushOutput } from '../terminal-session.ts';
import type { OutputBuffer, ServerMessage } from '../terminal-session.ts';

/** Lines of scrollback kept in memory. ~1500 short lines is a few MB at worst. */
export const MAX_SCROLLBACK = 1500;
const MAX_HISTORY = 50;

export type TermStatus = 'connecting' | 'open' | 'closed' | 'exited' | 'error';
export type ShellMode = 'pty' | 'pipe';

export interface TermSessionState {
  /** What the socket was opened against; a different key means a new shell. */
  readonly key: unknown;
  readonly term: TermState;
  readonly status: TermStatus;
  readonly mode: ShellMode | null;
  readonly error: string;
  readonly history: readonly string[];
}

/** Opens the socket; async because the upgrade URL needs a ticket first. */
export type SocketOpener = () => Promise<WebSocket>;

const EMPTY: TermSessionState = Object.freeze({
  key: null, term: createTermState(), status: 'connecting', mode: null, error: '', history: [],
});

let state: TermSessionState = EMPTY;
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let buffer: OutputBuffer = EMPTY_OUTPUT;
let geometry = { cols: 80, rows: 24 };
let flushTimer: ReturnType<typeof setInterval> | null = null;
// Bumped per open so a socket whose ticket resolves after it was superseded
// closes itself instead of attaching to a session that moved on.
let generation = 0;
let completionHandler: (msg: ServerMessage) => void = () => {};

function setState(patch: Partial<TermSessionState>): void {
  state = Object.freeze({ ...state, ...patch });
  for (const fn of listeners) fn();
}

export function getTermSession(): TermSessionState {
  return state;
}

export function subscribeTermSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The screen's measured cols/rows; what `feed` wraps at. */
export function setTermGeometry(next: { readonly cols: number; readonly rows: number }): void {
  geometry = next;
}

/** The screen's completion dance reads render-current refs, so it registers itself. */
export function setTermCompletionHandler(fn: (msg: ServerMessage) => void): void {
  completionHandler = fn;
}

/** Parses whatever output has queued since the last tick into the screen buffer. */
export function flushTerm(): void {
  const { text, next } = drainOutput(buffer);
  buffer = next;
  if (text.length === 0) return;
  const options: TermOptions = { ...geometry, maxLines: MAX_SCROLLBACK };
  setState({ term: feed(state.term, text, options) });
}

function closeSocket(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (!socket) return;
  const s = socket;
  socket = null;
  s.onopen = null;
  s.onmessage = null;
  s.onerror = null;
  s.onclose = null;
  try { s.close(); } catch { /* already closing */ }
}

function attach(opened: WebSocket): void {
  socket = opened;
  flushTimer = setInterval(flushTerm, FLUSH_MS);
  // Under node (the tests) a live interval pins the process; RN has no unref.
  (flushTimer as { unref?: () => void }).unref?.();
  opened.onopen = () => { if (socket === opened) setState({ status: 'open' }); };
  opened.onmessage = (event: MessageEvent) => {
    if (socket !== opened) return;
    const msg = parseServerMessage(event.data);
    if (!msg) return;
    if (msg.type === 'ready') setState({ mode: msg.mode === 'pipe' ? 'pipe' : 'pty' });
    else if (msg.type === 'data' && msg.data !== undefined) buffer = pushOutput(buffer, msg.data);
    else if (msg.type === 'completion') completionHandler(msg);
    else if (msg.type === 'exit') {
      buffer = pushOutput(buffer, '\r\n');
      setState({ status: 'exited' });
    }
  };
  opened.onerror = () => {
    if (socket !== opened) return;
    setState({ error: 'the terminal connection failed', status: state.status === 'exited' ? state.status : 'error' });
  };
  opened.onclose = () => {
    if (socket !== opened) return;
    if (state.status !== 'exited' && state.status !== 'error') setState({ status: 'closed' });
  };
}

async function open(opener: SocketOpener): Promise<void> {
  generation += 1;
  const gen = generation;
  let opened: WebSocket;
  try {
    opened = await opener();
  } catch (e: unknown) {
    if (gen !== generation) return;
    setState({ status: 'error', error: e instanceof Error ? e.message : 'could not open a terminal session' });
    return;
  }
  if (gen !== generation) { try { opened.close(); } catch { /* never opened */ } return; }
  attach(opened);
}

/**
 * Called on every mount of the Terminal screen. A live (or still opening)
 * shell against the same key is left alone — that is the whole fix. A new
 * key, or a shell that already ended, starts fresh.
 */
export function ensureTermSession(key: unknown, opener: SocketOpener): void {
  const alive = state.status === 'connecting' || state.status === 'open';
  if (state.key === key && alive) return;
  closeSocket();
  buffer = EMPTY_OUTPUT;
  const history = state.key === key ? state.history : [];
  setState({ ...EMPTY, key, history });
  void open(opener);
}

/** Reconnect: a new shell against the same key, scrollback cleared. */
export function reopenTermSession(opener: SocketOpener): void {
  closeSocket();
  buffer = EMPTY_OUTPUT;
  setState({ ...EMPTY, key: state.key, history: state.history });
  void open(opener);
}

/** Sends a control message; false when the socket is not open. */
export function postTerm(message: object): boolean {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** Keystrokes to the shell; a failure is surfaced on the glass. */
export function sendTerm(data: string): boolean {
  if (!socket || socket.readyState !== 1) return false;
  if (postTerm({ type: 'data', data })) return true;
  setState({ error: 'could not reach the shell — try reconnecting' });
  return false;
}

export function clearTerm(): void {
  buffer = EMPTY_OUTPUT;
  setState({ term: clearTermState(state.term) });
}

export function pushTermHistory(command: string): void {
  const next = [...state.history.filter((h) => h !== command), command];
  setState({ history: next.slice(-MAX_HISTORY) });
}
