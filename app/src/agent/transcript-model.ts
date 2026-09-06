// Pure state for watching a terminal-started session: the /ws/transcript
// wire (hello, events, live, error) parsed defensively and folded into one
// immutable state, plus the few words the read-only view says about it.
// No React and no react-native, so `transcript-model.test.mjs` runs it in
// plain Node — same contract as model.ts.

import type { AgentEvent } from '../api';
import { EVENT_CAP, parseEvent } from './model.ts';
import type { Link } from './model';

export interface TranscriptSession {
  readonly claudeSessionId: string;
  readonly cwd: string;
  readonly preview: string;
}

export type TranscriptMessage =
  | { readonly type: 'hello'; readonly session: TranscriptSession; readonly events: readonly AgentEvent[]; readonly offset: number; readonly live: boolean; readonly lastWriteAt: number }
  | { readonly type: 'events'; readonly events: readonly AgentEvent[]; readonly offset: number; readonly live: boolean; readonly lastWriteAt: number }
  | { readonly type: 'live'; readonly live: boolean; readonly lastWriteAt: number }
  | { readonly type: 'error'; readonly error: string };

export interface TranscriptState {
  readonly link: Link;
  readonly session: TranscriptSession | null;
  readonly events: readonly AgentEvent[];
  /** Byte offset the host will read from next — for a REST catch-up. */
  readonly offset: number;
  /** A terminal is driving this session right now. */
  readonly live: boolean;
  readonly lastWriteAt: number;
  readonly note: string;
}

export const INITIAL_TRANSCRIPT: TranscriptState = Object.freeze({
  link: 'connecting',
  session: null,
  events: [],
  offset: 0,
  live: false,
  lastWriteAt: 0,
  note: '',
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parseEvents(v: unknown): AgentEvent[] {
  if (!Array.isArray(v)) return [];
  const out: AgentEvent[] = [];
  for (const e of v) {
    const ev = parseEvent(e);
    if (ev) out.push(ev);
  }
  return out;
}

function parseSession(v: unknown): TranscriptSession | null {
  if (!isRecord(v)) return null;
  const claudeSessionId = str(v.claudeSessionId);
  if (!claudeSessionId) return null;
  return { claudeSessionId, cwd: str(v.cwd) ?? '', preview: str(v.preview) ?? '' };
}

/**
 * One socket frame. Anything malformed — a frame type this app does not
 * know, a hello without its session, an offset that is not a number — is
 * null: the wire is external input, and a newer host must degrade to
 * "ignored", never to garbage state.
 */
export function parseTranscriptMessage(raw: unknown): TranscriptMessage | null {
  let msg: unknown = raw;
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw); } catch { return null; }
  }
  if (!isRecord(msg)) return null;
  const live = msg.live === true;
  const lastWriteAt = num(msg.lastWriteAt) ?? 0;
  switch (msg.type) {
    case 'hello': {
      const session = parseSession(msg.session);
      const offset = num(msg.offset);
      if (!session || offset === undefined) return null;
      return { type: 'hello', session, events: parseEvents(msg.events), offset, live, lastWriteAt };
    }
    case 'events': {
      const offset = num(msg.offset);
      if (offset === undefined) return null;
      return { type: 'events', events: parseEvents(msg.events), offset, live, lastWriteAt };
    }
    case 'live':
      return { type: 'live', live, lastWriteAt };
    case 'error':
      return { type: 'error', error: str(msg.error) ?? 'the host refused the transcript' };
    default:
      return null;
  }
}

export type TranscriptAction =
  | { readonly type: 'link'; readonly link: Link }
  | { readonly type: 'message'; readonly message: TranscriptMessage }
  | { readonly type: 'note'; readonly note: string };

/** Keep the newest EVENT_CAP events, like the live session feed. */
function capped(events: readonly AgentEvent[]): readonly AgentEvent[] {
  return events.length > EVENT_CAP ? events.slice(events.length - EVENT_CAP) : events;
}

export function reduceTranscript(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'link':
      return state.link === action.link ? state : { ...state, link: action.link };
    case 'note':
      return state.note === action.note ? state : { ...state, note: action.note };
    case 'message': {
      const m = action.message;
      switch (m.type) {
        case 'hello':
          return {
            ...state, link: 'open', note: '', session: m.session,
            events: capped(m.events), offset: m.offset, live: m.live, lastWriteAt: m.lastWriteAt,
          };
        case 'events':
          return {
            ...state,
            events: m.events.length ? capped([...state.events, ...m.events]) : state.events,
            offset: m.offset, live: m.live, lastWriteAt: m.lastWriteAt,
          };
        case 'live':
          return state.live === m.live && state.lastWriteAt === m.lastWriteAt
            ? state
            : { ...state, live: m.live, lastWriteAt: m.lastWriteAt };
        case 'error':
          return { ...state, link: 'error', note: m.error };
      }
    }
  }
  return state;
}

/**
 * The one line under the feed. While a terminal drives the session the
 * phone only watches; once it has gone quiet the phone may take over.
 */
export function watchLine(state: TranscriptState): 'watching' | 'quiet' | 'none' {
  if (state.link !== 'open' || !state.session) return 'none';
  return state.live ? 'watching' : 'quiet';
}

/** "● LIVE" or "quiet · 4m" for the header, from the transcript's clock. */
export function liveLabel(live: boolean, lastWriteAt: number, now: number, ago: (t: number, now: number) => string): string {
  if (live) return '● LIVE';
  return lastWriteAt > 0 ? `quiet · ${ago(lastWriteAt, now)}` : 'quiet';
}
